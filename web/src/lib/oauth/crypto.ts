/**
 * Mã hoá refresh token TRƯỚC KHI ghi xuống Supabase (Module 0).
 *
 * Vì sao không lưu plaintext:
 *   • Refresh token SP-API/Ads = QUYỀN ĐỌC TOÀN BỘ shop trong 365 ngày. Rò rỉ một
 *     lần (dump DB, log, screenshot SQL Editor) là phải re-authorize từng chủ shop.
 *   • `connections.oauth_tokens` đã cấm mọi truy cập client (RLS không policy),
 *     nhưng lớp mã hoá này là chốt cuối: kể cả service_role key bị lộ, kẻ tấn công
 *     vẫn cần OAUTH_TOKEN_ENC_KEY (biến riêng, không bao giờ đưa lên client).
 *
 * Định dạng:  enc:v1:<base64url(iv 12B | tag 16B | ciphertext)>
 *   • AES-256-GCM — có tag xác thực: sửa 1 bit là giải mã FAIL (không ra rác âm thầm).
 *   • Tiền tố `enc:v1:` để sau này đổi thuật toán/rotate key vẫn đọc được bản cũ.
 *   • RPC `vexim_oauth_upsert_token` (migration 0020) TỪ CHỐI chuỗi không có tiền tố
 *     này và từ chối thẳng token plaintext `Atzr…` — fail-closed ở cả 2 tầng.
 *
 * Khoá: OAUTH_TOKEN_ENC_KEY — 64 ký tự hex (32 byte), base64 của 32 byte, hoặc một
 * passphrase bất kỳ (được SHA-256 xuống 32 byte). Thiếu khoá → NÉM LỖI, không bao
 * giờ "tiện thể" lưu plaintext.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const TOKEN_CIPHER_PREFIX = "enc:v1:";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class TokenCryptoError extends Error {
  readonly code: "missing_key" | "bad_payload" | "decrypt_failed";

  constructor(code: TokenCryptoError["code"], message: string) {
    super(message);
    this.name = "TokenCryptoError";
    this.code = code;
  }
}

/**
 * Chuẩn hoá khoá về đúng 32 byte.
 * Nhận hex 64 ký tự, base64 của 32 byte, hoặc passphrase (SHA-256).
 */
export function deriveTokenKey(secret: string): Buffer {
  const trimmed = (secret ?? "").trim();
  if (!trimmed) {
    throw new TokenCryptoError(
      "missing_key",
      "OAUTH_TOKEN_ENC_KEY trống. Sinh khoá: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const asBase64 = Buffer.from(trimmed, "base64");
  if (asBase64.length === KEY_BYTES && asBase64.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) {
    return asBase64;
  }
  // Passphrase → SHA-256. Vẫn an toàn để dùng, nhưng khuyến nghị khoá ngẫu nhiên.
  return createHash("sha256").update(trimmed).digest();
}

/** Chuỗi đã ở dạng `enc:v1:…` chưa? */
export function isEncryptedToken(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(TOKEN_CIPHER_PREFIX);
}

/** Trông có phải refresh token plaintext của Amazon không (Atzr|… / Atza|…)? */
export function looksLikePlainRefreshToken(value: string | null | undefined): boolean {
  return typeof value === "string" && /^Atz[ar]\|/.test(value.trim());
}

/** Mã hoá. iv ngẫu nhiên cho MỖI lần gọi → cùng token cho ra 2 bản khác nhau. */
export function encryptToken(plain: string, secret: string): string {
  const value = (plain ?? "").trim();
  if (!value) throw new TokenCryptoError("bad_payload", "Token rỗng — không có gì để mã hoá.");
  const key = deriveTokenKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return TOKEN_CIPHER_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64url");
}

/**
 * Giải mã. KHÔNG trả plaintext cho chuỗi không có tiền tố enc:v1: — nếu DB còn
 * bản cũ plaintext thì báo lỗi rõ ràng để đội vận hành rotate, thay vì âm thầm chấp nhận.
 */
export function decryptToken(payload: string, secret: string): string {
  if (!isEncryptedToken(payload)) {
    if (looksLikePlainRefreshToken(payload)) {
      throw new TokenCryptoError(
        "bad_payload",
        "Token trong DB là PLAINTEXT (Atzr…). Mã hoá lại bằng encryptToken() rồi cập nhật.",
      );
    }
    throw new TokenCryptoError("bad_payload", `Payload không có tiền tố ${TOKEN_CIPHER_PREFIX}`);
  }
  const key = deriveTokenKey(secret);
  const raw = Buffer.from(payload.slice(TOKEN_CIPHER_PREFIX.length), "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new TokenCryptoError("bad_payload", "Payload mã hoá quá ngắn (thiếu iv/tag).");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Sai khoá hoặc payload bị sửa → GCM fail. KHÔNG đoán, không trả chuỗi rỗng.
    throw new TokenCryptoError(
      "decrypt_failed",
      "Giải mã refresh token thất bại: sai OAUTH_TOKEN_ENC_KEY hoặc dữ liệu đã bị sửa.",
    );
  }
}

/**
 * So khớp 2 chuỗi không lộ độ dài (dùng khi kiểm tra state/secret).
 * Khác độ dài → false (timingSafeEqual ném lỗi nên phải chặn trước).
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a ?? "", "utf8");
  const bb = Buffer.from(b ?? "", "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Sinh khoá mới để in ra hướng dẫn khi thiếu env (không tự ghi vào env). */
export function suggestTokenKey(): string {
  return randomBytes(KEY_BYTES).toString("hex");
}
