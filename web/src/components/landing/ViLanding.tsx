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
          --blue:#2563eb;
          --radius:14px;
          --shadow:0 1px 2px rgba(15,23,32,.05), 0 8px 24px rgba(15,23,32,.06);
        }
        *{ -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
        .landing-wrap{max-width:1120px;margin:0 auto;padding:0 24px; font-family:"Inter", var(--font-inter, "Inter"), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; letter-spacing:-0.011em}
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
        .landing-step p{font-size:14.5px;color:var(--muted);line-height:1.55}
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
        .landing-module-card p{font-size:13.5px;color:var(--muted);line-height:1.5}
        .landing-sec-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
        .landing-sec-item{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px 22px}
        .landing-sec-item .s-ico{flex:none;width:38px;height:38px;border-radius:10px;background:var(--green-soft);color:var(--green);display:grid;place-items:center;font-size:17px;font-weight:900}
        .landing-sec-item h3{font-size:15.5px;margin-bottom:4px;color:var(--ink)}
        .landing-sec-item p{font-size:13.8px;color:var(--muted);line-height:1.5}
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
            VEXIM&nbsp;Ops <small>Vận hành Amazon</small>
          </a>
          <nav className={`landing-nav-links ${mobileOpen ? "open" : ""}`}>
            <a href="#platform" onClick={() => setMobileOpen(false)}>Cách hoạt động</a>
            <a href="#departments" onClick={() => setMobileOpen(false)}>Công việc</a>
            <a href="#modules" onClick={() => setMobileOpen(false)}>Tính năng</a>
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
              <span className="landing-badge"><span className="b-dot"></span> Kết nối chính thức Amazon • Đồng bộ Buy Box, FBA, Quảng cáo</span>
              <h1>Bán hàng Amazon<br/><em>hiệu quả hơn, lợi nhuận rõ hơn.</em></h1>
              <p className="landing-lead">VEXIM Ops giúp bạn quản lý toàn bộ gian hàng Amazon trên một nơi: giữ Buy Box, chống hết hàng FBA, tối ưu listing, quảng cáo Sponsored Products, đơn hàng FBM và báo cáo lợi nhuận thực sau phí. Không còn Excel rời rạc, không bỏ lỡ doanh thu vì hết hàng hay đốt ngân sách.</p>
              <div className="landing-ctas">
                <a className="landing-btn landing-btn-dark" href="#contact">Yêu cầu demo live →</a>
                <a className="landing-btn landing-btn-ghost" href="#platform">Xem cách hoạt động</a>
              </div>
              <p className="landing-note">Kết nối gian hàng bằng tài khoản Amazon, có thể ngắt kết nối bất kỳ lúc nào trong Seller Central. Dữ liệu đơn hàng, tồn kho, quảng cáo được cập nhật liên tục.</p>
              <div className="landing-bullets">
                <span>✓ Giữ Buy Box & giá cạnh tranh</span>
                <span>✓ Chống hết hàng FBA</span>
                <span>✓ Tối ưu ACOS / TACOS / ROAS</span>
                <span>✓ Bảo vệ sức khỏe tài khoản</span>
              </div>
            </div>

            <div className="landing-mock" aria-hidden="true">
              <div className="landing-mock-top">
                <span className="landing-dots"><i></i><i></i><i></i></span>
                Dashboard — Toàn bộ gian hàng Amazon
                <span className="landing-live"><i></i> Live</span>
              </div>
              <div className="landing-mock-body">
                <div className="landing-mock-title">Hôm qua · 14 gian hàng · $12,480 doanh thu</div>
                <div className="landing-kpis">
                  <div className="landing-kpi">
                    <div className="k-label">Doanh thu</div>
                    <div className="k-value">$12,480</div>
                    <div className="k-delta up">▲ 8.2% vs tuần trước</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Đơn hàng</div>
                    <div className="k-value">341</div>
                    <div className="k-delta up">▲ 4.7% · Tỷ lệ chuyển đổi 4.2%</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Chi phí quảng cáo · TACOS</div>
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
                  <div className="landing-alert red"><span className="a-icon"></span>2 SKU sắp hết hàng FBA (còn 5 ngày bán) — cần nhập hàng hôm nay, ~$410/ngày nếu đứt hàng</div>
                  <div className="landing-alert amber"><span className="a-icon"></span>2 chiến dịch Sponsored Products cạn ngân sách trước 18h — đang bỏ lỡ hiển thị</div>
                  <div className="landing-alert green"><span className="a-icon"></span>Sức khỏe tài khoản đạt chuẩn Amazon — không có vi phạm mở</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="platform" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Cách hoạt động</div>
              <h2>Từ kết nối gian hàng đến hành động mỗi ngày — trong 30 phút</h2>
              <p>Không cần file Excel, không copy-paste thủ công. Dữ liệu lấy trực tiếp từ Amazon: đơn hàng, tồn kho FBA, listing, giá Buy Box, quảng cáo, phí và settlement — tất cả về một dashboard, mỗi sáng biết ngay việc gì cần làm.</p>
            </div>
            <div className="landing-steps">
              <div className="landing-step reveal">
                <div className="landing-step-n">1</div>
                <h3>Kết nối gian hàng Amazon</h3>
                <p>Chủ gian hàng bấm “Kết nối Amazon” trong Seller Central, đăng nhập bằng tài khoản Amazon. Kết nối an toàn, có thể ngắt bất kỳ lúc nào. Hệ thống tự động theo dõi đơn hàng mới, thay đổi Buy Box, cảnh báo listing.</p>
              </div>
              <div className="landing-step reveal">
                <div className="landing-step-n">2</div>
                <h3>Đồng bộ tự động — không bỏ sót tín hiệu</h3>
                <p><b>Realtime</b> đơn hàng & Buy Box, <b>hằng giờ</b> tồn kho FBA & giá, <b>hằng ngày</b> báo cáo doanh thu, quảng cáo, phí lưu kho và settlement. Lịch sử 30 ngày có ngay sau khi kết nối — dashboard có số thật trong &lt;30 phút.</p>
              </div>
              <div className="landing-step reveal">
                <div className="landing-step-n">3</div>
                <h3>Hành động mỗi ngày theo cảnh báo</h3>
                <p>Mỗi đội mở dashboard riêng với chỉ số cốt lõi: SKU sắp hết hàng, listing mất Buy Box, campaign cạn ngân sách, tin nhắn khách hàng quá hạn. Mọi thay đổi giá, listing, quảng cáo đều lưu lịch sử trước/sau.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="departments" className="landing-section landing-departments">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Làm việc như người bán Amazon chuyên nghiệp</div>
              <h2>Một dashboard cho mỗi công việc, một ngôn ngữ chung về tăng trưởng</h2>
              <p>Mỗi người chỉ thấy gian hàng và công việc được giao. Không còn tình trạng “ai cũng thấy hết, không ai chịu trách nhiệm” — việc nào, người nào, rõ ràng.</p>
            </div>
            <div className="landing-dept-grid">
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">🛡️</div>
                <h3>Sức khỏe tài khoản Amazon</h3>
                <p>Theo dõi Account Health Rating, vi phạm chính sách, listing bị Amazon gỡ, yêu cầu cung cấp giấy tờ — cảnh báo sớm trước khi bị hạn chế bán hàng.</p>
                <span className="landing-dept-kpi">Mỗi ngày: AHR · Vi phạm mở · Nhiệm vụ cần xử lý</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">🏷️</div>
                <h3>Listing & Tồn kho lỗi</h3>
                <p>Quản lý listing Active, Suppressed, Stranded Inventory, lỗi hình ảnh, tiêu đề, từ khóa. Ưu tiên xử lý theo doanh thu bị ảnh hưởng.</p>
                <span className="landing-dept-kpi">Mỗi ngày: Listing lỗi · Stranded · Doanh thu bị mất</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">💰</div>
                <h3>Giá & Buy Box</h3>
                <p>Giám sát giá đối thủ, tỷ lệ thắng Buy Box, tính biên lợi nhuận thực sau phí FBA và phí giới thiệu Amazon. Duyệt tăng/giảm giá theo quy trình.</p>
                <span className="landing-dept-kpi">Mỗi ngày: % Buy Box · SKU mất Buy Box · Biên lợi nhuận</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">📦</div>
                <h3>Tồn kho FBA & Nhập hàng</h3>
                <p>Dự báo số ngày bán còn lại (Days of Cover), cảnh báo hết hàng theo doanh thu, theo dõi lô hàng inbound, tồn kho lâu ngày và phí lưu kho FBA.</p>
                <span className="landing-dept-kpi">Mỗi ngày: SKU sắp hết · Giá trị tồn kho · Lô hàng đang vận chuyển</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">📈</div>
                <h3>Quảng cáo Amazon Ads</h3>
                <p>Quản lý Sponsored Products, Sponsored Brands, Sponsored Display, ngân sách, giá thầu, báo cáo Search Term, gợi ý từ khóa phủ định để giảm ACOS.</p>
                <span className="landing-dept-kpi">Mỗi ngày: ACOS · TACOS · Campaign cạn ngân sách</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">💬</div>
                <h3>Đơn hàng & Chăm sóc khách hàng</h3>
                <p>Theo dõi đơn FBM sắp quá hạn giao hàng, tin nhắn của người mua (Buyer Message) cần trả lời trong 24h, xử lý trả hàng & hoàn tiền, theo dõi Feedback.</p>
                <span className="landing-dept-kpi">Mỗi ngày: Tin nhắn chưa trả lời · Đơn FBM quá hạn · Tỷ lệ trả hàng</span>
              </div>
            </div>
          </div>
        </section>

        <section id="modules" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Tất cả công việc bán hàng Amazon trong một nền tảng</div>
              <h2>Không phải công cụ rời rạc, mà là hệ điều hành cho gian hàng Amazon</h2>
              <p>Từ CEO nhìn toàn cảnh đến từng đội xử lý chi tiết: doanh thu, Buy Box, FBA, quảng cáo, đơn hàng và lợi nhuận — tất cả liên thông với nhau.</p>
            </div>
            <div className="landing-modules-grid">
              <div className="landing-module-card reveal"><div className="m-ico">📊</div><div><h3>Dashboard tổng quan</h3><p>Doanh thu, đơn hàng, lợi nhuận, TACOS, tỷ lệ Buy Box, top SKU bán chạy, cảnh báo đỏ/vàng/xanh theo tác động doanh thu.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🛡️</div><div><h3>Sức khỏe tài khoản</h3><p>Account Health Rating, ODR, Late Shipment Rate, vi phạm thương hiệu, listing bị gỡ — không bỏ lỡ cảnh báo quan trọng từ Amazon.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🏷️</div><div><h3>Quản lý Listing</h3><p>Theo dõi trạng thái listing, lỗi suppressed, stranded inventory, giá bán, tồn kho FBA, Buy Box — chỉnh sửa hàng loạt và duyệt thay đổi.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">💲</div><div><h3>Giá & Lợi nhuận thực</h3><p>So sánh giá đối thủ, tính lợi nhuận thực sau phí FBA, phí referral, quảng cáo. Xem P&L theo SKU, theo ngày, theo gian hàng.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">📦</div><div><h3>Tồn kho FBA & Nhập hàng</h3><p>Tồn kho theo kho FBA, dự báo hết hàng, đề xuất nhập hàng, theo dõi inbound shipment, tồn kho lâu ngày và phí lưu kho.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🎯</div><div><h3>Quảng cáo & Từ khóa khách tìm</h3><p>Campaign → Ad Group → Keyword, báo cáo Search Term thực tế khách tìm kiếm, gợi ý thêm từ khóa và phủ định để giảm chi phí, điều chỉnh ngân sách & bid.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🧾</div><div><h3>Đơn hàng FBM & Trả hàng</h3><p>Đơn hàng FBA/FBM, đếm ngược thời hạn giao hàng, tin nhắn người mua, xử lý hoàn hàng — không bỏ sót đơn quá hạn.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">💰</div><div><h3>Tài chính & Đối soát Amazon</h3><p>Báo cáo Settlement, phí FBA, bồi hoàn FBA (Reimbursement), lợi nhuận theo SKU, chi phí quảng cáo — đối soát rõ ràng, lưu lịch sử không xóa được.</p></div></div>
            </div>
          </div>
        </section>

        <section id="security" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">An toàn & Tin cậy</div>
              <h2>Dữ liệu gian hàng được bảo vệ như tài sản</h2>
              <p>Chỉ kết nối chính thức với Amazon, không scraping, không dùng nguồn dữ liệu ngoài. Tuân thủ chính sách bảo vệ dữ liệu của Amazon.</p>
            </div>
            <div className="landing-sec-grid">
              <div className="landing-sec-item reveal"><div className="s-ico">✓</div><div><h3>Chỉ kết nối chính thức Amazon</h3><p>Dữ liệu lấy trực tiếp từ Seller Central qua API chính thức của Amazon. Không cào dữ liệu, không chia sẻ chéo giữa các gian hàng.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🔑</div><div><h3>Kết nối an toàn, thu hồi dễ dàng</h3><p>Kết nối bằng tài khoản Amazon, có thể ngắt kết nối bất kỳ lúc nào trong Seller Central. Tự động nhắc gia hạn khi sắp hết hạn.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🔒</div><div><h3>Bảo mật & mã hóa</h3><p>Mã hóa toàn bộ dữ liệu, không lưu thông tin nhạy cảm của người mua. Chỉ dùng dữ liệu để vận hành đơn hàng — không bán, không dùng cho quảng cáo.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🧑‍💻</div><div><h3>Phân quyền rõ ràng</h3><p>Mỗi nhân viên chỉ thấy gian hàng và công việc được giao. Mọi thay đổi giá, listing, quảng cáo đều lưu lịch sử trước/sau — không xóa được.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🗑️</div><div><h3>Xóa dữ liệu khi ngắt kết nối</h3><p>Khi bạn ngắt kết nối gian hàng, dữ liệu được xóa theo chính sách lưu trữ đã cam kết với Amazon — đúng cam kết bảo vệ dữ liệu.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🛠️</div><div><h3>Vận hành bởi đội ngũ chuyên nghiệp</h3><p>Đội ngũ VEXIM đã vận hành hàng chục gian hàng Amazon, hiểu rõ nỗi đau hết hàng, mất Buy Box, đốt tiền quảng cáo và cách xử lý.</p></div></div>
            </div>
          </div>
        </section>

        <section id="about" className="landing-section">
          <div className="landing-wrap landing-split">
            <div className="landing-about">
              <div className="landing-kicker">Về VEXIM</div>
              <h2>Đối tác vận hành Amazon, không chỉ là công cụ</h2>
              <p>VEXIM là agency vận hành Amazon có trụ sở tại Việt Nam, quản lý gian hàng cho các thương hiệu tăng trưởng. Chúng tôi vận hành listing, quảng cáo, tồn kho FBA, đơn hàng và tài chính cho hàng chục đối tác.</p>
              <p><b>VEXIM Ops</b> là nền tảng chúng tôi xây cho chính mình — để mọi gian hàng được vận hành với cùng một kỷ luật: <b>doanh số rõ ràng, lợi nhuận rõ ràng, hành động mỗi ngày rõ ràng</b>.</p>
              <ul>
                <li>✅ <b>Giữ doanh thu:</b> chống hết hàng FBA, mất Buy Box, listing bị suppressed, campaign cạn ngân sách.</li>
                <li>✅ <b>Tăng lợi nhuận thực:</b> tính P&L sau phí FBA, phí giới thiệu, quảng cáo, đòi bồi hoàn FBA từ Amazon.</li>
                <li>✅ <b>Tiết kiệm thời gian:</b> không còn Excel rời rạc, cảnh báo tự động, duyệt thay đổi nhanh, hoàn tác 1 chạm.</li>
                <li>✅ <b>Minh bạch cho khách hàng:</b> cổng báo cáo riêng xem doanh thu, tồn kho, quảng cáo — không cần hỏi qua chat.</li>
              </ul>
            </div>
            <div className="landing-contact-card" id="contact">
              <h3>Trò chuyện cùng chúng tôi</h3>
              <p>Xem demo live trên dữ liệu Amazon thật và lộ trình để gian hàng của bạn được vận hành bằng VEXIM Ops.</p>
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
          VEXIM Ops là sản phẩm độc lập, không liên kết với Amazon.com, Inc. “Amazon”, “Buy Box”, “FBA”, “Sponsored Products” là nhãn hiệu của Amazon.com, Inc. Nền tảng tuân thủ chính sách API và bảo vệ dữ liệu của Amazon.
        </div>
      </footer>
    </>
  );
}
