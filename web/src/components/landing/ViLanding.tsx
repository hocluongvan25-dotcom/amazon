"use client";

import { useEffect, useState } from "react";

export default function ViLanding() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [year, setYear] = useState(2026);

  useEffect(() => {
    setYear(new Date().getFullYear());
    // reveal on scroll
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 },
    );
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <>
      <style>{`
        :root{
          --ink:#0f1720; --muted:#5b6472; --soft:#8a93a3;
          --bg:#f7f8fa; --card:#ffffff; --line:#e5e8ee;
          --accent:#ff9900; --accent-ink:#b25f00; --accent-soft:#fff4e5;
          --green:#0e9f6e; --green-soft:#e6f7f0;
          --red:#e02424; --red-soft:#fdeaea;
          --amber:#c27803; --amber-soft:#fdf3e0;
          --blue:#2563eb;
          --radius:14px;
          --shadow:0 1px 2px rgba(15,23,32,.05), 0 8px 24px rgba(15,23,32,.06);
        }
        .landing-wrap{max-width:1120px;margin:0 auto;padding:0 24px}
        .landing-header{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.86);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
        .landing-nav{display:flex;align-items:center;gap:28px;height:68px}
        .landing-logo{display:flex;align-items:center;gap:10px;font-weight:900;font-size:18px;letter-spacing:-.02em;color:var(--ink)}
        .landing-logo-mark{width:32px;height:32px;border-radius:9px;background:var(--ink);display:grid;place-items:center;color:var(--accent);font-size:16px;font-weight:900}
        .landing-logo small{font-weight:700;color:var(--soft);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;margin-left:2px}
        .landing-nav-links{display:flex;gap:24px;margin-left:auto;font-size:14.5px;color:var(--muted);font-weight:600}
        .landing-nav-links a:hover{color:var(--ink)}
        .landing-btn{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:14.5px;border-radius:999px;padding:11px 22px;cursor:pointer;border:1px solid transparent;transition:.18s;text-decoration:none}
        .landing-btn-dark{background:var(--ink);color:#fff}
        .landing-btn-dark:hover{background:#232f3e;transform:translateY(-1px)}
        .landing-btn-ghost{border-color:var(--line);background:#fff;color:var(--ink)}
        .landing-btn-ghost:hover{border-color:#c9cfda}
        .landing-burger{display:none;margin-left:auto;background:none;border:0;font-size:22px;cursor:pointer;color:var(--ink)}
        .landing-hero{padding:84px 0 72px;background:radial-gradient(1000px 400px at 85% -10%, #fff4e5 0%, transparent 60%),radial-gradient(700px 380px at -10% 10%, #eaf1ff 0%, transparent 55%), var(--bg)}
        .landing-hero-grid{display:grid;grid-template-columns:1.08fr .92fr;gap:52px;align-items:center}
        .landing-badge{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);color:var(--muted);font-size:12.5px;font-weight:700;padding:7px 14px;border-radius:999px;box-shadow:var(--shadow)}
        .landing-badge .b-dot{width:7px;height:7px;border-radius:50%;background:var(--green)}
        .landing-hero h1{font-size:clamp(34px,4.8vw,54px);line-height:1.05;letter-spacing:-.035em;font-weight:900;margin:20px 0 18px;color:var(--ink)}
        .landing-hero h1 em{font-style:normal;color:var(--accent-ink);white-space:nowrap}
        .landing-lead{font-size:17.5px;color:var(--muted);max-width:560px;margin-bottom:30px;line-height:1.6}
        .landing-ctas{display:flex;gap:12px;flex-wrap:wrap}
        .landing-note{margin-top:18px;font-size:12.5px;color:var(--soft);line-height:1.5}
        .landing-bullets{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
        .landing-bullets span{font-size:11.5px;font-weight:700;color:var(--muted);background:#fff;border:1px solid var(--line);padding:5px 11px;border-radius:999px}
        .landing-mock{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden}
        .landing-mock-top{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--muted);font-weight:600}
        .landing-dots{display:flex;gap:5px}
        .landing-dots i{width:9px;height:9px;border-radius:50%;background:#e3e7ee;display:inline-block}
        .landing-live{margin-left:auto;display:inline-flex;align-items:center;gap:6px;color:var(--green);font-weight:800}
        .landing-live i{width:7px;height:7px;border-radius:50%;background:var(--green);animation:landing-pulse 1.6s infinite;display:inline-block}
        @keyframes landing-pulse{0%,100%{opacity:1}50%{opacity:.35}}
        .landing-mock-body{padding:18px}
        .landing-mock-title{font-size:11.5px;font-weight:800;color:var(--soft);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
        .landing-kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px}
        .landing-kpi{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#fbfcfe}
        .landing-kpi .k-label{font-size:11px;color:var(--soft);font-weight:700;text-transform:uppercase;letter-spacing:.06em}
        .landing-kpi .k-value{font-size:20px;font-weight:900;letter-spacing:-.02em;margin-top:2px;color:var(--ink)}
        .landing-kpi .k-delta{font-size:11.5px;font-weight:700;margin-top:2px}
        .up{color:var(--green)} .down{color:var(--red)} .flat{color:var(--soft)}
        .landing-spark{display:flex;align-items:flex-end;gap:5px;height:44px;margin:4px 0 14px}
        .landing-spark i{flex:1;background:linear-gradient(180deg,#bfd3f5,#8fb3f0);border-radius:3px 3px 0 0;opacity:.9;display:inline-block}
        .landing-spark i:last-child{background:linear-gradient(180deg,#ffd9a0,#ffb84d)}
        .landing-alerts{display:flex;flex-direction:column;gap:8px}
        .landing-alert{display:flex;gap:9px;align-items:flex-start;border-radius:10px;padding:10px 12px;font-size:12.8px;font-weight:600;line-height:1.45}
        .landing-alert .a-icon{width:8px;height:8px;border-radius:50%;margin-top:5px;flex:none;display:inline-block}
        .landing-alert.red{background:var(--red-soft);color:#a01717}.landing-alert.red .a-icon{background:var(--red)}
        .landing-alert.amber{background:var(--amber-soft);color:#8a5602}.landing-alert.amber .a-icon{background:var(--amber)}
        .landing-alert.green{background:var(--green-soft);color:#0b7a55}.landing-alert.green .a-icon{background:var(--green)}
        .landing-section{padding:80px 0}
        .landing-sec-head{max-width:720px;margin-bottom:44px}
        .landing-kicker{font-size:12px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:var(--accent-ink);margin-bottom:12px}
        .landing-sec-head h2{font-size:clamp(28px,3.6vw,40px);letter-spacing:-.025em;line-height:1.12;font-weight:900;margin-bottom:14px;color:var(--ink)}
        .landing-sec-head p{color:var(--muted);font-size:17px;line-height:1.6}
        .landing-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
        .landing-step{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:28px 24px;box-shadow:var(--shadow)}
        .landing-step-n{width:36px;height:36px;border-radius:10px;background:var(--accent-soft);color:var(--accent-ink);display:grid;place-items:center;font-weight:900;font-size:15px;margin-bottom:16px}
        .landing-step h3{font-size:17.5px;margin-bottom:8px;letter-spacing:-.01em;color:var(--ink)}
        .landing-step p{font-size:14.5px;color:var(--muted)}
        .landing-departments{background:#fff;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
        .landing-dept-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
        .landing-dept{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:26px;transition:.18s}
        .landing-dept:hover{transform:translateY(-3px);box-shadow:var(--shadow);background:#fff}
        .landing-dept-ico{font-size:22px;width:48px;height:48px;border-radius:12px;background:#fff;border:1px solid var(--line);display:grid;place-items:center;margin-bottom:14px}
        .landing-dept h3{font-size:16.5px;margin-bottom:7px;letter-spacing:-.01em;color:var(--ink)}
        .landing-dept p{font-size:14px;color:var(--muted);line-height:1.55}
        .landing-dept-kpi{display:inline-block;margin-top:12px;font-size:11.5px;font-weight:800;color:var(--accent-ink);background:var(--accent-soft);border-radius:999px;padding:5px 12px}
        .landing-modules-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
        .landing-module-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:22px 24px;display:flex;gap:14px}
        .landing-module-card .m-ico{flex:none;width:40px;height:40px;border-radius:10px;background:var(--bg);border:1px solid var(--line);display:grid;place-items:center;font-size:18px}
        .landing-module-card h3{font-size:15.5px;margin-bottom:4px;color:var(--ink)}
        .landing-module-card p{font-size:13.5px;color:var(--muted)}
        .landing-sec-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
        .landing-sec-item{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px 22px}
        .landing-sec-item .s-ico{flex:none;width:38px;height:38px;border-radius:10px;background:var(--green-soft);color:var(--green);display:grid;place-items:center;font-size:17px;font-weight:900}
        .landing-sec-item h3{font-size:15.5px;margin-bottom:4px;color:var(--ink)}
        .landing-sec-item p{font-size:13.8px;color:var(--muted)}
        .landing-split{display:grid;grid-template-columns:1.1fr .9fr;gap:40px;align-items:start}
        .landing-about p{color:var(--muted);font-size:16.5px;margin-bottom:14px;line-height:1.65}
        .landing-about ul{margin:12px 0 0 18px;color:var(--muted);font-size:15px}
        .landing-about li{margin-bottom:6px}
        .landing-contact-card{background:var(--ink);color:#fff;border-radius:18px;padding:34px 32px;box-shadow:var(--shadow)}
        .landing-contact-card h3{font-size:22px;margin-bottom:8px;letter-spacing:-.01em}
        .landing-contact-card p{color:#b9c2cf;font-size:14.5px;margin-bottom:22px}
        .landing-contact-row{display:flex;gap:12px;align-items:center;padding:12px 0;border-top:1px solid #26313f;font-size:14.5px}
        .landing-contact-row:first-of-type{border-top:0}
        .landing-contact-row .c-ico{width:34px;height:34px;border-radius:9px;background:#1d2836;display:grid;place-items:center;font-size:15px}
        .landing-contact-row b{display:block;font-size:11px;color:#8f9aa9;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
        .landing-contact-row span{color:#e7ebf1}
        .landing-footer{border-top:1px solid var(--line);background:#fff;padding:36px 0;font-size:13.5px;color:var(--soft)}
        .landing-foot{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
        .landing-foot .sep{flex:1}
        .landing-foot a:hover{color:var(--ink)}
        .reveal{opacity:0;transform:translateY(14px);transition:.6s ease}
        .reveal.in{opacity:1;transform:none}
        @media (max-width:980px){
          .landing-nav-links{display:none}
          .landing-burger{display:block}
          .landing-nav-links.open{display:flex;position:absolute;top:68px;left:0;right:0;background:#fff;border-bottom:1px solid var(--line);flex-direction:column;padding:18px 24px;gap:16px}
          .landing-hero-grid,.landing-split{grid-template-columns:1fr}
          .landing-steps,.landing-dept-grid{grid-template-columns:1fr 1fr}
          .landing-sec-grid,.landing-modules-grid{grid-template-columns:1fr}
        }
        @media (max-width:640px){
          .landing-steps,.landing-dept-grid,.landing-kpis{grid-template-columns:1fr}
          .landing-section{padding:56px 0}
          .landing-hero{padding:56px 0 52px}
        }
      `}</style>

      <header className="landing-header">
        <div className="landing-wrap landing-nav">
          <a className="landing-logo" href="#top">
            <span className="landing-logo-mark">V</span>
            VEXIM&nbsp;Ops <small>Nền tảng vận hành Amazon</small>
          </a>
          <nav className={`landing-nav-links ${mobileOpen ? "open" : ""}`}>
            <a href="#platform" onClick={() => setMobileOpen(false)}>Nền tảng</a>
            <a href="#departments" onClick={() => setMobileOpen(false)}>Phòng ban</a>
            <a href="#modules" onClick={() => setMobileOpen(false)}>Module</a>
            <a href="#security" onClick={() => setMobileOpen(false)}>Bảo mật</a>
            <a href="#about" onClick={() => setMobileOpen(false)}>Về VEXIM</a>
            <a href="#contact" onClick={() => setMobileOpen(false)}>Liên hệ</a>
          </nav>
          <a className="landing-btn landing-btn-dark" href="#contact">Yêu cầu demo</a>
          <button className="landing-burger" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Menu">☰</button>
        </div>
      </header>

      <main id="top">
        <section className="landing-hero">
          <div className="landing-wrap landing-hero-grid">
            <div>
              <span className="landing-badge"><span className="b-dot"></span> Kết nối chính thức qua Amazon SP-API & Ads API • Không scraping</span>
              <h1>Vận hành Amazon<br/><em>tập trung & đo được.</em></h1>
              <p className="landing-lead">VEXIM Ops là nền tảng quản trị vận hành Amazon đa gian hàng cho agency và brand tăng trưởng. Kết nối shop qua OAuth chính thức, dữ liệu chảy về theo thời gian thực và được chuyển hoá thành hành động hằng ngày cho từng phòng ban — giảm thất thoát, giữ Buy Box, tối ưu biên lợi nhuận.</p>
              <div className="landing-ctas">
                <a className="landing-btn landing-btn-dark" href="#contact">Yêu cầu demo live →</a>
                <a className="landing-btn landing-btn-ghost" href="#platform">Xem cách vận hành</a>
              </div>
              <p className="landing-note">Chủ shop uỷ quyền 1 lần bằng Login with Amazon (OAuth 2.0), có thể thu hồi bất kỳ lúc nào trong Seller Central. Token LWA được mã hoá, tự động nhắc gia hạn trước 30 ngày.</p>
              <div className="landing-bullets">
                <span>✓ Multi-tenant: VEXIM → Doanh nghiệp → Shop</span>
                <span>✓ RBAC 6 vai trò + phân quyền theo phòng ban</span>
                <span>✓ 12 SOP chuẩn hoá</span>
                <span>✓ Audit log & RLS cấp database</span>
              </div>
            </div>

            <div className="landing-mock" aria-hidden="true">
              <div className="landing-mock-top">
                <span className="landing-dots"><i></i><i></i><i></i></span>
                Dashboard CEO — Toàn bộ gian hàng
                <span className="landing-live"><i></i> Live</span>
              </div>
              <div className="landing-mock-body">
                <div className="landing-mock-title">Hôm qua · Toàn hệ thống · 14 shop</div>
                <div className="landing-kpis">
                  <div className="landing-kpi">
                    <div className="k-label">Doanh thu thuần</div>
                    <div className="k-value">$12,480</div>
                    <div className="k-delta up">▲ 8.2% vs cùng kỳ tuần trước</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Đơn hàng</div>
                    <div className="k-value">341</div>
                    <div className="k-delta up">▲ 4.7% · CR 4.2%</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Chi phí QC · TACOS</div>
                    <div className="k-value">$862</div>
                    <div className="k-delta flat">TACOS 6.9% · Mục tiêu ≤ 8%</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Tỷ lệ giữ Buy Box</div>
                    <div className="k-value">93%</div>
                    <div className="k-delta down">▼ 1 SKU mất Buy Box</div>
                  </div>
                </div>
                <div className="landing-spark">
                  <i style={{height:"38%"}}></i><i style={{height:"52%"}}></i><i style={{height:"44%"}}></i><i style={{height:"63%"}}></i><i style={{height:"57%"}}></i><i style={{height:"72%"}}></i><i style={{height:"88%"}}></i>
                </div>
                <div className="landing-alerts">
                  <div className="landing-alert red"><span className="a-icon"></span>2 SKU sắp hết hàng (cover 5 ngày) — cần kế hoạch nhập hôm nay, ~$410/ngày nếu đứt</div>
                  <div className="landing-alert amber"><span className="a-icon"></span>2 campaign cạn ngân sách trước 18h — đang bỏ lỡ hiển thị</div>
                  <div className="landing-alert green"><span className="a-icon"></span>Sức khỏe tài khoản toàn hệ thống đạt chuẩn Amazon</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="platform" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Nền tảng vận hành</div>
              <h2>Từ kết nối đến hành động trong 30 phút</h2>
              <p>Không file Excel rời rạc, không copy-paste thủ công. Toàn bộ dữ liệu lấy trực tiếp từ API chính thức của Amazon, chuẩn hoá về Supabase và phân phối theo quyền từng phòng ban — mỗi con số đều trả lời “hôm nay phải làm gì”.</p>
            </div>
            <div className="landing-steps">
              <div className="landing-step reveal">
                <div className="landing-step-n">1</div>
                <h3>Kết nối gian hàng chính thức</h3>
                <p>Chủ tài khoản bấm “Kết nối Amazon” trong Seller Central, uỷ quyền qua OAuth 2.0. Hệ thống nhận LWA refresh token, mã hoá bằng Supabase Vault, tự động đăng ký nhận thông báo ORDER_CHANGE, ANY_OFFER_CHANGED, LISTINGS_ITEM_ISSUES_CHANGE.</p>
              </div>
              <div className="landing-step reveal">
                <div className="landing-step-n">2</div>
                <h3>Đồng bộ 3 tầng — không bỏ sót tín hiệu</h3>
                <p><b>Tầng 1 Realtime</b> (EventBridge/SQS), <b>Tầng 2 Incremental</b> (15–60 phút), <b>Tầng 3 Báo cáo đối soát</b> (hằng ngày). Backfill 30 ngày đơn hàng, tồn kho, listing và settlement ngay sau khi kết nối — dashboard có số thật trong &lt;30 phút.</p>
              </div>
              <div className="landing-step reveal">
                <div className="landing-step-n">3</div>
                <h3>Phòng ban hành động theo cảnh báo</h3>
                <p>Mỗi phòng ban mở dashboard riêng với 5–8 chỉ số cốt lõi và hàng đợi ưu tiên theo doanh thu/nguy cơ. Mọi thao tác ghi (đổi giá, sửa listing, duyệt campaign) đều ghi audit log với before/after.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="departments" className="landing-section landing-departments">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Vận hành theo phòng ban — đúng cách Amazon vận hành</div>
              <h2>Một dashboard cho mỗi đội, một ngôn ngữ chung về tăng trưởng</h2>
              <p>Cơ chế phân quyền RBAC 6 cấp (super_admin → client_viewer) kết hợp RLS cấp database đảm bảo mỗi người chỉ thấy shop và module được giao. Không còn tình trạng “ai cũng thấy hết, không ai chịu trách nhiệm”.</p>
            </div>
            <div className="landing-dept-grid">
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">🛡️</div>
                <h3>Vận hành & Sức khỏe tài khoản</h3>
                <p>Theo dõi Account Health Rating, vi phạm chính sách, listing bị gỡ, KYC, khiếu nại — cảnh báo sớm trước khi Amazon hạn chế.</p>
                <span className="landing-dept-kpi">KPI hằng ngày: AHR · Vi phạm mở · Nhiệm vụ quá SLA</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">🏷️</div>
                <h3>Listing & Nội dung</h3>
                <p>Quản lý vòng đời listing: active/inactive/stranded, lỗi chất lượng, hàng đợi duyệt nội dung, editor tuân thủ giới hạn Amazon.</p>
                <span className="landing-dept-kpi">KPI hằng ngày: Listing lỗi · Chờ duyệt · Doanh thu/ngày bị ảnh hưởng</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">💰</div>
                <h3>Định giá & Buy Box</h3>
                <p>Giám sát đối thủ, giữ tỷ lệ thắng Buy Box, tính biên lợi nhuận sau phí FBA/referral, phê duyệt chiến lược giá theo SOP.</p>
                <span className="landing-dept-kpi">KPI hằng ngày: % Buy Box · SKU mất Buy Box · Biên lợi nhuận</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">📦</div>
                <h3>Kho vận & FBA</h3>
                <p>Dự báo days-of-cover, cảnh báo sắp hết hàng xếp theo doanh thu, theo dõi inbound shipment, tồn kho lâu ngày.</p>
                <span className="landing-dept-kpi">KPI hằng ngày: SKU sắp hết · Giá trị tồn kho · Nhập hàng đang vận chuyển</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">📈</div>
                <h3>Quảng cáo PPC</h3>
                <p>Quản lý Sponsored Products/SB/SD, ngân sách, bid, phân tích search term, đề xuất phủ định (Negative Exact/Phrase) theo SOP-04.</p>
                <span className="landing-dept-kpi">KPI hằng ngày: ACOS · TACOS · Campaign vượt ngân sách</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">💬</div>
                <h3>Đơn hàng & CSKH</h3>
                <p>Hàng đợi FBM với deadline giao hàng, tin nhắn buyer theo SLA 24h, xử lý return/refund, theo dõi feedback.</p>
                <span className="landing-dept-kpi">KPI hằng ngày: Tin nhắn chưa trả lời · Đơn FBM quá hạn · Tỷ lệ hoàn</span>
              </div>
            </div>
          </div>
        </section>

        <section id="modules" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Hệ thống module — khớp 100% luồng vận hành thực tế</div>
              <h2>Không phải công cụ rời rạc, mà là hệ điều hành cho Amazon</h2>
              <p>30+ route được thiết kế theo hành trình vận hành: từ CEO nhìn toàn cảnh → từng phòng ban xử lý chi tiết → đối soát tài chính → cổng khách hàng minh bạch.</p>
            </div>
            <div className="landing-modules-grid">
              <div className="landing-module-card reveal"><div className="m-ico">📊</div><div><h3>Dashboard CEO</h3><p>Doanh thu, đơn hàng, TACOS, shop cần xử lý gấp, biểu đồ 14 ngày, cảnh báo đỏ/vàng/xanh theo tác động doanh thu.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🛡️</div><div><h3>Sức khỏe tài khoản</h3><p>AHR, ODR, Late Shipment, vi phạm IP, nhiệm vụ KYC — đồng bộ qua Account Health API & notification.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🏷️</div><div><h3>Listing</h3><p>Listings Items API + Catalog, hàng đợi lỗi theo doanh thu, editor tuân thủ giới hạn ký tự, quy trình duyệt.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">💲</div><div><h3>Định giá & Phê duyệt</h3><p>Product Pricing & Fees API, so sánh đối thủ, tính P&L theo SKU, luồng phê duyệt giá 2 cấp.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">📦</div><div><h3>Tồn kho & Nhập hàng</h3><p>FBA Inventory API, dự báo tiêu thụ, cảnh báo hết hàng, tạo inbound shipment (2024-03-20), theo dõi FC allocation.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🎯</div><div><h3>PPC & Search Term</h3><p>Ads API v3, chi tiết campaign → ad group → keyword, báo cáo search term, hàng đợi duyệt Negative, ghi ngược lên Amazon có audit & revert 1 chạm.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🧾</div><div><h3>Đơn hàng FBM & Returns</h3><p>Orders API, countdown SLA giao hàng, tin nhắn buyer, xử lý hoàn hàng — không bỏ sót đơn quá hạn.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">💰</div><div><h3>Tài chính & Đối soát</h3><p>Settlement, Financial Events, FBA reimbursements, profit theo SKU, chi phí quảng cáo — đối soát append-only.</p></div></div>
            </div>
          </div>
        </section>

        <section id="security" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Bảo mật & Tuân thủ — chuẩn duyệt Amazon Developer</div>
              <h2>Dữ liệu gian hàng được đối xử như tài sản</h2>
              <p>Thiết kế tuân thủ Amazon Data Protection Policy và các quy định bảo vệ dữ liệu hiện hành. Không scraping, không nguồn dữ liệu bên thứ ba.</p>
            </div>
            <div className="landing-sec-grid">
              <div className="landing-sec-item reveal"><div className="s-ico">✓</div><div><h3>Chỉ tích hợp API chính thức</h3><p>Toàn bộ dữ liệu lấy từ SP-API & Advertising API qua TLS. Không cào dữ liệu, không chia sẻ chéo giữa các seller (multi-tenant RLS).</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🔑</div><div><h3>Uỷ quyền & thu hồi minh bạch</h3><p>Shop kết nối qua OAuth 2.0 của Amazon, có thể thu hồi trong Seller Central bất kỳ lúc nào. Token hết hạn 1 năm — hệ thống nhắc gia hạn trước 30 ngày.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🔒</div><div><h3>Mã hoá & tối thiểu hoá PII</h3><p>Mã hoá in-transit & at-rest, LWA token lưu trong Supabase Vault. Dữ liệu người mua chỉ dùng để thực hiện đơn hàng — không bán, không dùng cho quảng cáo.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🧑‍💻</div><div><h3>RBAC & Nhật ký kiểm toán</h3><p>6 vai trò, phân quyền theo phòng ban & shop, mọi thao tác ghi (giá, listing, campaign) đều lưu before/after trong audit_logs — không xoá được.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🗑️</div><div><h3>Xoá dữ liệu khi thu hồi</h3><p>Khi seller thu hồi uỷ quyền, token bị xoá ngay lập tức và dữ liệu gian hàng được thanh lọc theo chính sách lưu trữ — đúng cam kết với Amazon.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🛠️</div><div><h3>Vận hành bởi đội ngũ chịu trách nhiệm</h3><p>Quyền production giới hạn cho nhân sự VEXIM đã đào tạo, xác thực đa yếu tố, nguyên tắc đặc quyền tối thiểu.</p></div></div>
            </div>
          </div>
        </section>

        <section id="about" className="landing-section">
          <div className="landing-wrap landing-split">
            <div className="landing-about">
              <div className="landing-kicker">Về VEXIM</div>
              <h2>Đối tác vận hành, không chỉ là công cụ</h2>
              <p>VEXIM là agency vận hành marketplace có trụ sở tại Việt Nam, quản lý gian hàng Amazon cho các doanh nghiệp tăng trưởng. Chúng tôi vận hành listing, quảng cáo, tồn kho, đơn hàng và tài chính cho hàng chục đối tác bán hàng.</p>
              <p><b>VEXIM Ops</b> là nền tảng chúng tôi xây cho chính mình — để mọi gian hàng được vận hành với cùng một kỷ luật: <b>số liệu rõ ràng, người chịu trách nhiệm rõ ràng, hành động hằng ngày rõ ràng</b>.</p>
              <ul>
                <li>✅ <b>Giảm thất thoát doanh thu:</b> chống hết hàng, mất Buy Box, đốt ngân sách QC, listing “tàng hình”.</li>
                <li>✅ <b>Tăng biên lợi nhuận:</b> tính P&L theo SKU sau phí, tối ưu ACOS/TACOS, đòi bồi hoàn FBA.</li>
                <li>✅ <b>Chuẩn hoá SOP:</b> 12 quy trình vận hành chuẩn, từ cảnh báo đến phê duyệt & revert 1 chạm.</li>
                <li>✅ <b>Minh bạch cho khách hàng:</b> cổng client portal xem doanh thu, tồn kho, báo cáo — không cần hỏi qua chat.</li>
              </ul>
            </div>
            <div className="landing-contact-card" id="contact">
              <h3>Trò chuyện cùng chúng tôi</h3>
              <p>Xem demo live trên dữ liệu marketplace thật và lộ trình để gian hàng của bạn được vận hành bằng VEXIM Ops.</p>
              <div className="landing-contact-row"><span className="c-ico">✉️</span><div><b>Email</b><span>ops@vexim.vn</span></div></div>
              <div className="landing-contact-row"><span className="c-ico">📞</span><div><b>Hotline</b><span>+84 28 1234 5678</span></div></div>
              <div className="landing-contact-row"><span className="c-ico">📍</span><div><b>Văn phòng</b><span>TP. Hồ Chí Minh, Việt Nam</span></div></div>
              <div className="landing-contact-row"><span className="c-ico">🔗</span><div><b>Nền tảng</b><span><a href="/login" style={{color:"#ffd9a0", textDecoration:"underline"}}>Đăng nhập VEXIM Ops →</a></span></div></div>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-wrap landing-foot">
          <span>© {year} VEXIM Co., Ltd. Bảo lưu mọi quyền.</span>
          <span className="sep" style={{flex:1}}></span>
          <a href="#security">Bảo vệ dữ liệu</a>
          <a href="#contact">Liên hệ</a>
          <a href="/login">Đăng nhập</a>
        </div>
        <div className="landing-wrap" style={{marginTop:"10px", fontSize:"12px", lineHeight:"1.6"}}>
          VEXIM Ops là sản phẩm độc lập, không được chứng thực bởi hay liên kết với Amazon.com, Inc. “Amazon” và “Selling Partner API” là nhãn hiệu của Amazon.com, Inc. Nền tảng tuân thủ SP-API Acceptable Use Policy & Data Protection Policy.
        </div>
      </footer>
    </>
  );
}
