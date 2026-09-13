"use client";

import { useEffect, useState } from "react";

export default function ViLanding() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [year, setYear] = useState(2026);

  useEffect(() => {
    setYear(new Date().getFullYear());
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
          --radius:14px;
          --shadow:0 1px 2px rgba(15,23,32,.05), 0 8px 24px rgba(15,23,32,.06);
        }
        *{ -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
        .landing-wrap{max-width:1120px;margin:0 auto;padding:0 24px; font-family:"Inter", var(--font-inter, "Inter"), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; letter-spacing:-0.011em}
        .landing-header{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.86);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
        .landing-nav{display:flex;align-items:center;gap:16px;height:68px;white-space:nowrap}
        .landing-logo{display:flex;align-items:center;gap:10px;font-weight:900;font-size:18px;letter-spacing:-.02em;color:var(--ink);flex:none}
        .landing-logo-mark{width:32px;height:32px;border-radius:9px;background:var(--ink);display:grid;place-items:center;color:var(--accent);font-size:16px;font-weight:900}
        .landing-nav-links{display:flex;gap:20px;margin-left:auto;font-size:14px;color:var(--muted);font-weight:600;white-space:nowrap;flex-wrap:nowrap}
        .landing-nav-links a{white-space:nowrap}
        .landing-nav-links a:hover{color:var(--ink)}
        .landing-btn{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:14.5px;border-radius:999px;padding:11px 22px;cursor:pointer;border:1px solid transparent;transition:.18s;text-decoration:none;white-space:nowrap;flex:none}
        .landing-btn-dark{background:var(--ink);color:#fff}
        .landing-btn-dark:hover{background:#232f3e;transform:translateY(-1px)}
        .landing-btn-ghost{border-color:var(--line);background:#fff;color:var(--ink)}
        .landing-btn-ghost:hover{border-color:#c9cfda}
        .landing-burger{display:none;margin-left:auto;background:none;border:0;font-size:22px;cursor:pointer;color:var(--ink);flex:none}
        .landing-hero{padding:84px 0 72px;background:radial-gradient(1000px 400px at 85% -10%, #fff4e5 0%, transparent 60%),radial-gradient(700px 380px at -10% 10%, #eaf1ff 0%, transparent 55%), var(--bg)}
        .landing-hero-grid{max-width:1280px;margin:0 auto;padding:0 16px;display:grid;grid-template-columns:1fr;gap:32px;align-items:center}
        @media(min-width:1024px){ .landing-hero-grid{grid-template-columns:repeat(12,minmax(0,1fr))} }
        .landing-badge{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);color:var(--muted);font-size:12.5px;font-weight:700;padding:7px 14px;border-radius:999px;box-shadow:var(--shadow)}
        .landing-badge .b-dot{width:7px;height:7px;border-radius:50%;background:var(--green)}
        .landing-hero h1{font-size:clamp(32px,4.4vw,48px);line-height:1.08;letter-spacing:-.03em;font-weight:900;margin:20px 0 16px;color:var(--ink)}
        .landing-hero h1 em{font-style:normal;color:var(--accent-ink)}
        .landing-lead{font-size:17px;color:var(--muted);max-width:600px;margin-bottom:26px;line-height:1.7}
        .landing-ctas{display:flex;gap:12px;flex-wrap:wrap}
        .landing-note{margin-top:16px;font-size:12.5px;color:var(--soft);line-height:1.6;max-width:600px}
        .landing-bullets{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
        .landing-bullets span{font-size:11.5px;font-weight:700;color:var(--muted);background:#fff;border:1px solid var(--line);padding:5px 11px;border-radius:999px}
        .landing-mock{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);overflow:hidden;width:100%;height:auto;object-fit:contain;min-width:0}
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
        .landing-alert{display:flex;gap:9px;align-items:flex-start;border-radius:10px;padding:10px 12px;font-size:12.8px;font-weight:600;line-height:1.5}
        .landing-alert .a-icon{width:8px;height:8px;border-radius:50%;margin-top:5px;flex:none;display:inline-block}
        .landing-alert.red{background:var(--red-soft);color:#a01717}.landing-alert.red .a-icon{background:var(--red)}
        .landing-alert.amber{background:var(--amber-soft);color:#8a5602}.landing-alert.amber .a-icon{background:var(--amber)}
        .landing-alert.green{background:var(--green-soft);color:#0b7a55}.landing-alert.green .a-icon{background:var(--green)}
        .landing-section{padding:80px 0}
        .landing-sec-head{max-width:720px;margin-bottom:44px}
        .landing-kicker{font-size:12px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:var(--accent-ink);margin-bottom:12px}
        .landing-sec-head h2{font-size:clamp(28px,3.6vw,40px);letter-spacing:-.025em;line-height:1.12;font-weight:900;margin-bottom:14px;color:var(--ink)}
        .landing-sec-head p{color:var(--muted);font-size:17px;line-height:1.7}
        .landing-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
        .landing-step{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:28px 24px;box-shadow:var(--shadow)}
        .landing-step-n{width:36px;height:36px;border-radius:10px;background:var(--accent-soft);color:var(--accent-ink);display:grid;place-items:center;font-weight:900;font-size:15px;margin-bottom:16px}
        .landing-step h3{font-size:17.5px;margin-bottom:8px;letter-spacing:-.01em;color:var(--ink)}
        .landing-step p{font-size:14.5px;color:var(--muted);line-height:1.6}
        .landing-departments{background:#fff;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
        .landing-dept-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
        .landing-dept{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:26px;transition:.18s}
        .landing-dept:hover{transform:translateY(-3px);box-shadow:var(--shadow);background:#fff}
        .landing-dept-ico{font-size:22px;width:48px;height:48px;border-radius:12px;background:#fff;border:1px solid var(--line);display:grid;place-items:center;margin-bottom:14px}
        .landing-dept h3{font-size:16.5px;margin-bottom:7px;letter-spacing:-.01em;color:var(--ink)}
        .landing-dept p{font-size:14px;color:var(--muted);line-height:1.6}
        .landing-dept-kpi{display:inline-block;margin-top:12px;font-size:11.5px;font-weight:800;color:var(--accent-ink);background:var(--accent-soft);border-radius:999px;padding:5px 12px}
        .landing-modules-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
        .landing-module-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:22px 24px;display:flex;gap:14px}
        .landing-module-card .m-ico{flex:none;width:40px;height:40px;border-radius:10px;background:var(--bg);border:1px solid var(--line);display:grid;place-items:center;font-size:18px}
        .landing-module-card h3{font-size:15.5px;margin-bottom:4px;color:var(--ink)}
        .landing-module-card p{font-size:13.5px;color:var(--muted);line-height:1.55}
        .landing-sec-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
        .landing-sec-item{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px 22px}
        .landing-sec-item .s-ico{flex:none;width:38px;height:38px;border-radius:10px;background:var(--green-soft);color:var(--green);display:grid;place-items:center;font-size:17px;font-weight:900}
        .landing-sec-item h3{font-size:15.5px;margin-bottom:4px;color:var(--ink)}
        .landing-sec-item p{font-size:13.8px;color:var(--muted);line-height:1.55}
        .landing-split{display:grid;grid-template-columns:1.1fr .9fr;gap:40px;align-items:start}
        .landing-about p{color:var(--muted);font-size:16.5px;margin-bottom:14px;line-height:1.7}
        .landing-about ul{margin:12px 0 0 18px;color:var(--muted);font-size:15px}
        .landing-about li{margin-bottom:7px;line-height:1.6}
        .landing-contact-card{background:var(--ink);color:#fff;border-radius:18px;padding:34px 32px;box-shadow:var(--shadow)}
        .landing-contact-card h3{font-size:22px;margin-bottom:8px;letter-spacing:-.01em}
        .landing-contact-card p{color:#b9c2cf;font-size:14.5px;margin-bottom:22px;line-height:1.6}
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
        @media (max-width:1100px){
          .landing-nav-links{gap:14px;font-size:13.5px}
        }
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
            VEXIM Ops
          </a>
          <nav className={`landing-nav-links ${mobileOpen ? "open" : ""}`}>
            <a href="#platform" onClick={() => setMobileOpen(false)}>Hoạt động</a>
            <a href="#departments" onClick={() => setMobileOpen(false)}>Tính năng</a>
            <a href="#security" onClick={() => setMobileOpen(false)}>Bảo mật</a>
            <a href="#contact" onClick={() => setMobileOpen(false)}>Liên hệ</a>
          </nav>
          <a className="landing-btn landing-btn-dark" href="#contact">Xem demo</a>
          <button className="landing-burger" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Menu">☰</button>
        </div>
      </header>

      <main id="top">
        <section className="landing-hero">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center max-w-7xl mx-auto px-4">
            <div className="lg:col-span-7 min-w-0">
              <span className="landing-badge"><span className="b-dot"></span> Kết nối chính thức Amazon</span>
              <h1>Quản lý vận hành Amazon<br/><em>trên 1 nền tảng duy nhất.</em></h1>
              <p className="landing-lead">Bạn đang mở Seller Central để xem đơn, Ads Console để xem quảng cáo, rồi lại Excel để tính lời lỗ? VEXIM Ops làm thay bạn hết — tự canh <b>Buy Box</b> không để mất khách, báo trước khi <b>hết hàng FBA</b>, tối ưu <b>tiền quảng cáo</b> để giảm ACOS/TACOS, nhắc khi <b>tài khoản có nguy cơ</b> và đối soát <b>tiền Amazon trả về</b> rõ ràng. Mỗi sáng chỉ cần mở một chỗ là biết ngay hôm nay phải làm gì.</p>
              <div className="landing-ctas">
                <a className="landing-btn landing-btn-dark" href="#contact">Xem demo trên số thật →</a>
                <a className="landing-btn landing-btn-ghost" href="#platform">Nó hoạt động thế nào?</a>
              </div>
              <p className="landing-note">Kết nối bằng tài khoản Amazon, 30 giây là xong. Không dùng nữa thì ngắt ngay trong Seller Central — chúng tôi xóa dữ liệu theo đúng cam kết với Amazon.</p>
              <div className="landing-bullets">
                <span>✓ Không để mất Buy Box vì chậm đổi giá</span>
                <span>✓ Biết trước 5-7 ngày khi nào hết hàng FBA</span>
                <span>✓ Quảng cáo rõ lời lỗ ACOS / TACOS</span>
                <span>✓ Tài khoản khỏe, tránh bị cảnh báo</span>
              </div>
            </div>

            <div className="lg:col-span-5 min-w-0">
              <div className="landing-mock w-full h-auto object-contain" aria-hidden="true">
              <div className="landing-mock-top">
                <span className="landing-dots"><i></i><i></i><i></i></span>
                Tổng quan gian hàng • 14 Brands
                <span className="landing-live"><i></i> Live</span>
              </div>
              <div className="landing-mock-body">
                <div className="landing-mock-title">Hôm qua • $12,480 doanh thu • 341 đơn</div>
                <div className="landing-kpis">
                  <div className="landing-kpi">
                    <div className="k-label">Doanh thu</div>
                    <div className="k-value">$12,480</div>
                    <div className="k-delta up">▲ 8.2% so với tuần trước</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Đơn hàng</div>
                    <div className="k-value">341</div>
                    <div className="k-delta up">▲ 4.7% • Chuyển đổi 4.2%</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Tiền quảng cáo • TACOS</div>
                    <div className="k-value">$862</div>
                    <div className="k-delta flat">TACOS 6.9% • Trong mục tiêu</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Giữ Buy Box</div>
                    <div className="k-value">93%</div>
                    <div className="k-delta down">▼ 1 mã vừa mất Buy Box</div>
                  </div>
                </div>
                <div className="landing-spark">
                  <i style={{height:"38%"}}></i><i style={{height:"52%"}}></i><i style={{height:"44%"}}></i><i style={{height:"63%"}}></i><i style={{height:"57%"}}></i><i style={{height:"72%"}}></i><i style={{height:"88%"}}></i>
                </div>
                <div className="landing-alerts">
                  <div className="landing-alert red"><span className="a-icon"></span>2 mã sắp hết hàng FBA, chỉ còn đủ bán 5 ngày — nếu đứt, hụt $410/ngày.</div>
                  <div className="landing-alert amber"><span className="a-icon"></span>2 chiến dịch quảng cáo sắp hết ngân sách từ 18h — đang bỏ lỡ khách.</div>
                  <div className="landing-alert green"><span className="a-icon"></span>Tài khoản vẫn khỏe, không có cảnh báo nào đang mở.</div>
                </div>
              </div>
            </div>
          </div>
          </div>
        </section>

        <section id="platform" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Nó hoạt động thế nào?</div>
              <h2>Cắm vào là chạy, 30 phút là thấy số thật</h2>
              <p>Bạn không cần nhập liệu, không cần nối file. Chúng tôi lấy số trực tiếp từ Amazon rồi đặt vào đúng chỗ bạn cần — sáng mở lên là biết ngay hôm nay phải làm gì.</p>
            </div>
            <div className="landing-steps">
              <div className="landing-step reveal">
                <div className="landing-step-n">1</div>
                <h3>Kết nối gian hàng</h3>
                <p>Bấm “Kết nối Amazon” trong Seller Central, đăng nhập là xong. Kết nối chính chủ, an toàn, muốn ngắt lúc nào cũng được.</p>
              </div>
              <div className="landing-step reveal">
                <div className="landing-step-n">2</div>
                <h3>Hệ thống tự lo phần đồng bộ</h3>
                <p>Đơn mới hay đổi Buy Box thì báo ngay. Tồn kho FBA và giá cập nhật mỗi giờ. Doanh thu, quảng cáo, phí lưu kho, tiền Amazon trả về thì chốt theo ngày. Vừa kết nối xong là có sẵn 30 ngày lịch sử để xem luôn.</p>
              </div>
              <div className="landing-step reveal">
                <div className="landing-step-n">3</div>
                <h3>Mỗi sáng chỉ làm việc quan trọng</h3>
                <p>Dashboard chỉ hiện việc cần làm gấp: mã nào sắp hết, listing nào bị ẩn, chiến dịch nào sắp hết tiền, khách nào nhắn chưa trả lời. Làm xong việc nào, việc đó tự biến mất.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="departments" className="landing-section landing-departments">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Nền tảng làm thay bạn những gì?</div>
              <h2>Ai lo việc nấy, không bỏ sót việc nào làm mất tiền</h2>
              <p>Bạn giao shop nào, việc nào cho ai thì người đó chỉ thấy đúng phần đó. Không còn cảnh ai cũng xem hết rồi không ai làm.</p>
            </div>
            <div className="landing-dept-grid">
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">🛡️</div>
                <h3>Giữ tài khoản khỏe</h3>
                <p>Amazon vừa báo vi phạm gì, điểm sức khỏe tụt, có listing bị gỡ, cần nộp giấy tờ — hệ thống báo ngay để bạn xử lý trước khi bị hạn chế bán.</p>
                <span className="landing-dept-kpi">Nhìn mỗi ngày: điểm sức khỏe, vi phạm, việc cần làm</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">🏷️</div>
                <h3>Dọn listing lỗi</h3>
                <p>Mã nào bị Amazon ẩn (suppressed), hàng nằm chết trong kho (stranded), thiếu ảnh hay tiêu đề chưa chuẩn — xếp theo số tiền đang bị kẹt để bạn làm cái nặng trước.</p>
                <span className="landing-dept-kpi">Nhìn mỗi ngày: listing lỗi, hàng chết, tiền đang kẹt</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">💰</div>
                <h3>Canh giá & Buy Box</h3>
                <p>Đối thủ đang bán bao nhiêu, mình còn giữ Buy Box không, sau khi trừ phí FBA và phí Amazon thì còn lời bao nhiêu — muốn đổi giá thì gửi duyệt, duyệt xong mới lên sàn.</p>
                <span className="landing-dept-kpi">Nhìn mỗi ngày: % giữ Buy Box, mã mất Buy Box, biên lợi nhuận</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">📦</div>
                <h3>Không để hết hàng FBA</h3>
                <p>Mỗi mã còn bán được bao nhiêu ngày (Days of Cover), khi nào phải nhập thêm, lô hàng nào đang trên đường tới kho Amazon, mã nào nằm lâu đang bị tính phí lưu kho.</p>
                <span className="landing-dept-kpi">Nhìn mỗi ngày: mã sắp hết, tiền tồn, lô đang đi</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">📈</div>
                <h3>Tối ưu quảng cáo</h3>
                <p>Sponsored Products, Brands, Display — ngân sách, giá thầu, khách thực sự gõ từ gì (Search Term), từ nào nên loại để đỡ tốn tiền. Đốt tiền ở đâu, nhìn là thấy ngay.</p>
                <span className="landing-dept-kpi">Nhìn mỗi ngày: ACOS, TACOS, chiến dịch sắp hết tiền</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">💬</div>
                <h3>Không sót đơn & tin nhắn</h3>
                <p>Đơn FBM nào sắp trễ, tin nhắn nào của khách quá 24h chưa trả lời, trả hàng vì lý do gì — không để sót việc nào làm tụt điểm vận hành.</p>
                <span className="landing-dept-kpi">Nhìn mỗi ngày: tin nhắn chưa trả lời, đơn trễ, tỷ lệ trả hàng</span>
              </div>
            </div>
          </div>
        </section>

        <section id="modules" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Có gì bên trong?</div>
              <h2>Không phải nhiều tool rời rạc, mà là một chỗ làm hết</h2>
              <p>Từ lúc nhìn tổng quan đến lúc xử lý chi tiết, mọi thứ nối với nhau. Xem doanh thu rồi bấm vào là thấy ngay mã nào đang kéo xuống, vì sao mất Buy Box, quảng cáo đang đốt bao nhiêu.</p>
            </div>
            <div className="landing-modules-grid">
              <div className="landing-module-card reveal"><div className="m-ico">📊</div><div><h3>Nhìn toàn cảnh</h3><p>Doanh thu, đơn hàng, lợi nhuận, TACOS, Buy Box, mã bán chạy, việc cần làm gấp — gom hết lên một màn hình.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🛡️</div><div><h3>Sức khỏe tài khoản</h3><p>Điểm sức khỏe, ODR, tỷ lệ giao trễ, vi phạm, listing bị gỡ — Amazon báo gì là bạn thấy ngay.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🏷️</div><div><h3>Listing</h3><p>Mã nào đang bán, mã nào bị ẩn, hàng chết trong kho, giá, tồn FBA, Buy Box — sửa nhiều mã cùng lúc, có duyệt trước khi lên sàn.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">💲</div><div><h3>Lợi nhuận thực</h3><p>So giá đối thủ, tính lời thực sau phí FBA, phí Amazon và tiền quảng cáo. Biết chính xác đang lời ở đâu.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">📦</div><div><h3>Kho FBA & nhập hàng</h3><p>Tồn theo từng kho, dự báo khi nào hết, gợi ý nhập bao nhiêu, lô hàng đang đi tới đâu, mã nào nằm lâu tốn phí.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🎯</div><div><h3>Quảng cáo & từ khóa khách gõ</h3><p>Từ chiến dịch xuống từ khóa — thấy rõ khách gõ gì (Search Term), từ nào nên giữ, từ nào nên loại trừ.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🧾</div><div><h3>Đơn hàng & trả hàng</h3><p>Đơn FBA, FBM, đếm ngược hạn giao, tin nhắn khách, lý do trả hàng — không để sót đơn nào.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">💰</div><div><h3>Tài chính Amazon</h3><p>Tiền Amazon trả (Settlement), các loại phí, tiền bồi hoàn FBA, lợi nhuận theo mã — đối soát rõ ràng.</p></div></div>
            </div>
          </div>
        </section>

        <section id="security" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">An tâm bán hàng</div>
              <h2>Dữ liệu shop là tài sản, chúng tôi giữ như của mình</h2>
              <p>Chỉ kết nối chính thức với Amazon, không dùng mẹo vặt. Mọi thứ làm theo đúng chuẩn Amazon yêu cầu.</p>
            </div>
            <div className="landing-sec-grid">
              <div className="landing-sec-item reveal"><div className="s-ico">✓</div><div><h3>Kết nối chính thức Amazon</h3><p>Lấy số trực tiếp từ Seller Central, không cào dữ liệu, không chia sẻ số liệu giữa các shop.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🔑</div><div><h3>Muốn ngắt lúc nào cũng được</h3><p>Bạn kết nối bằng tài khoản Amazon của mình. Không muốn dùng nữa thì vào Seller Central bấm ngắt là xong.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🔒</div><div><h3>Giữ kín thông tin</h3><p>Toàn bộ dữ liệu được mã hóa, không lưu thông tin nhạy cảm của người mua. Chỉ dùng để vận hành đơn hàng.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🧑‍💻</div><div><h3>Ai làm gì đều ghi lại</h3><p>Mỗi người chỉ thấy shop và việc được giao. Đổi giá, sửa listing, chỉnh quảng cáo — ai đổi, đổi gì, đều lưu lại hết.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🗑️</div><div><h3>Ngắt là xóa</h3><p>Khi bạn ngắt kết nối, chúng tôi xóa dữ liệu shop theo đúng chính sách đã cam kết với Amazon.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🛠️</div><div><h3>Làm bởi người từng bán Amazon</h3><p>Đội VEXIM đã tự vận hành hàng chục gian hàng, từng mất Buy Box, từng hết hàng, từng đốt tiền quảng cáo — nên hiểu bạn cần gì.</p></div></div>
            </div>
          </div>
        </section>

        <section id="about" className="landing-section">
          <div className="landing-wrap landing-split">
            <div className="landing-about">
              <div className="landing-kicker">Vì sao VEXIM?</div>
              <h2>Chúng tôi làm agency Amazon trước, rồi mới làm phần mềm</h2>
              <p>VEXIM là đội vận hành Amazon ở Việt Nam, đang quản lý gian hàng cho nhiều thương hiệu. Ngày nào cũng làm listing, tối ưu quảng cáo, canh tồn kho FBA, xử lý đơn và đối soát tiền với Amazon.</p>
              <p><b>VEXIM Ops</b> là cái chúng tôi tự làm cho mình dùng trước — vì không tìm được tool nào gọn việc như cách mình muốn: <b>nhìn vào là biết đang lời hay lỗ, ai phải làm gì hôm nay.</b></p>
              <ul>
                <li>✅ <b>Đỡ hụt doanh thu:</b> không còn hết hàng FBA bất ngờ, mất Buy Box mà không biết, listing bị ẩn cả tuần, chiến dịch hết tiền giữa chừng.</li>
                <li>✅ <b>Thấy rõ lời thực:</b> sau khi trừ phí FBA, phí Amazon, tiền quảng cáo và cả tiền bồi hoàn — biết chính xác mã nào đang gánh team, mã nào đang lỗ.</li>
                <li>✅ <b>Đỡ mất thời gian:</b> bỏ Excel chắp vá, việc quan trọng tự nổi lên, duyệt đổi giá hay quảng cáo nhanh gọn.</li>
              </ul>
            </div>
            <div className="landing-contact-card" id="contact">
              <h3>Nói chuyện thử xem?</h3>
              <p>Chúng tôi demo trực tiếp trên số liệu Amazon thật, cho bạn thấy gian hàng của mình sẽ gọn lại thế nào.</p>
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
          <span>© {year} VEXIM Co., Ltd.</span>
          <span className="sep" style={{flex:1}}></span>
          <a href="#security">Bảo mật</a>
          <a href="#contact">Liên hệ</a>
          <a href="/login">Đăng nhập</a>
        </div>
        <div className="landing-wrap" style={{marginTop:"10px", fontSize:"12px", lineHeight:"1.6"}}>
          VEXIM Ops là sản phẩm độc lập, không liên kết với Amazon. “Amazon”, “Buy Box”, “FBA”, “Sponsored Products” là nhãn hiệu của Amazon.com, Inc.
        </div>
      </footer>
    </>
  );
}
