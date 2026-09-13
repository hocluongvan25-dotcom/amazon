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
        .landing-hero-grid{max-width:1280px;margin:0 auto;padding:0 16px;display:grid;grid-template-columns:1fr;gap:32px;align-items:center}
        @media(min-width:1024px){ .landing-hero-grid{grid-template-columns:repeat(12,minmax(0,1fr))} }
        .landing-badge{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);color:var(--muted);font-size:12.5px;font-weight:700;padding:7px 14px;border-radius:999px;box-shadow:var(--shadow)}
        .landing-badge .b-dot{width:7px;height:7px;border-radius:50%;background:var(--green)}
        .landing-hero h1{font-size:clamp(34px,4.8vw,54px);line-height:1.05;letter-spacing:-.035em;font-weight:900;margin:20px 0 18px;color:var(--ink)}
        .landing-hero h1 em{font-style:normal;color:var(--accent-ink);white-space:nowrap}
        .landing-lead{font-size:17px;color:var(--muted);max-width:640px;margin-bottom:28px;line-height:1.7}
        .landing-ctas{display:flex;gap:12px;flex-wrap:wrap}
        .landing-note{margin-top:18px;font-size:12.5px;color:var(--soft);line-height:1.6;max-width:640px}
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
        .landing-sec-head{max-width:760px;margin-bottom:44px}
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
            VEXIM&nbsp;Ops <small>Amazon Ops Platform</small>
          </a>
          <nav className={`landing-nav-links ${mobileOpen ? "open" : ""}`}>
            <a href="#platform" onClick={() => setMobileOpen(false)}>Kiến trúc đồng bộ</a>
            <a href="#departments" onClick={() => setMobileOpen(false)}>Vận hành hằng ngày</a>
            <a href="#modules" onClick={() => setMobileOpen(false)}>Module</a>
            <a href="#security" onClick={() => setMobileOpen(false)}>Bảo mật & Tuân thủ</a>
            <a href="#about" onClick={() => setMobileOpen(false)}>Về VEXIM</a>
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
              <span className="landing-badge"><span className="b-dot"></span> Amazon SP-API • Kết nối chính thức</span>
              <h1>Vận hành Amazon bằng dữ liệu thực:<br/><em>Buy Box, FBA, Ads, Settlement.</em></h1>
              <p className="landing-lead">VEXIM Ops hợp nhất toàn bộ dữ liệu Seller Central về một dashboard duy nhất: <b>Buy Box Ownership & Competitive Pricing</b>, <b>FBA Inventory Health & Days of Cover</b>, <b>Listing Suppressed & Stranded Inventory</b>, <b>Sponsored Products / Brands / Display & Search Term Report</b>, <b>FBM Orders & Buyer Message SLA</b>, <b>Settlement v2 & FBA Reimbursement</b>. Thay vì đối chiếu Seller Central, Brand Registry, Ads Console và Excel, bạn ra quyết định dựa trên <b>ACOS, TACOS, ROAS và Net Margin thực sau phí</b>.</p>
              <div className="landing-ctas">
                <a className="landing-btn landing-btn-dark" href="#contact">Xem demo trên dữ liệu thật →</a>
                <a className="landing-btn landing-btn-ghost" href="#platform">Kiến trúc đồng bộ</a>
              </div>
              <p className="landing-note">Kết nối OAuth qua Seller Central, phân quyền tối thiểu theo SP-API Roles (Brand/Marketplace). Hỗ trợ multi-marketplace US/EU/JP. Thu hồi quyền ngay trong Seller Central, tuân thủ Amazon Data Protection Policy (DPP) & Acceptable Use Policy (AUP).</p>
              <div className="landing-bullets">
                <span>✓ Buy Box Ownership & Price Competitiveness</span>
                <span>✓ FBA Days of Cover, Reorder Point & Inbound</span>
                <span>✓ Sponsored: ACOS / TACOS / ROAS & Search Term</span>
                <span>✓ Account Health: AHR, ODR, Policy Violation</span>
              </div>
            </div>

            <div className="lg:col-span-5 min-w-0">
              <div className="landing-mock w-full h-auto object-contain" aria-hidden="true">
              <div className="landing-mock-top">
                <span className="landing-dots"><i></i><i></i><i></i></span>
                Operations Dashboard • 14 Brands
                <span className="landing-live"><i></i> Live</span>
              </div>
              <div className="landing-mock-body">
                <div className="landing-mock-title">Yesterday • GMV $12,480 • 341 Orders</div>
                <div className="landing-kpis">
                  <div className="landing-kpi">
                    <div className="k-label">GMV</div>
                    <div className="k-value">$12,480</div>
                    <div className="k-delta up">▲ 8.2% WoW • Conversion 4.2%</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Orders • Units</div>
                    <div className="k-value">341</div>
                    <div className="k-delta up">▲ 4.7% • Sell-through 68%</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Ad Spend • TACOS</div>
                    <div className="k-value">$862</div>
                    <div className="k-delta flat">TACOS 6.9% • Within Target</div>
                  </div>
                  <div className="landing-kpi">
                    <div className="k-label">Buy Box Ownership</div>
                    <div className="k-value">93%</div>
                    <div className="k-delta down">▼ 1 SKU Buy Box Lost</div>
                  </div>
                </div>
                <div className="landing-spark">
                  <i style={{height:"38%"}}></i><i style={{height:"52%"}}></i><i style={{height:"44%"}}></i><i style={{height:"63%"}}></i><i style={{height:"57%"}}></i><i style={{height:"72%"}}></i><i style={{height:"88%"}}></i>
                </div>
                <div className="landing-alerts">
                  <div className="landing-alert red"><span className="a-icon"></span>FBA Stockout Risk: 2 SKU Days of Cover &lt;5, Revenue at Risk $410/ngày.</div>
                  <div className="landing-alert amber"><span className="a-icon"></span>Sponsored Products Out-of-Budget: 2 Campaigns Out-of-Budget từ 18h — Impression Share Lost.</div>
                  <div className="landing-alert green"><span className="a-icon"></span>Account Health: AHR Healthy, 0 Open Policy Violation, ODR 0.3%.</div>
                </div>
              </div>
            </div>
          </div>
          </div>
        </section>

        <section id="platform" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Kiến trúc đồng bộ</div>
              <h2>SP-API + Ads API + Settlement: đồng bộ liên tục, backfill 30 ngày</h2>
              <p>Không nhập liệu thủ công. VEXIM Ops kết nối trực tiếp Amazon SP-API, Advertising API và Settlement Reports, chuẩn hóa về SKU/ASIN, lưu vết audit log và hiển thị theo Revenue at Risk để ưu tiên xử lý.</p>
            </div>
            <div className="landing-steps">
              <div className="landing-step reveal">
                <div className="landing-step-n">1</div>
                <h3>Kết nối gian hàng qua SP-API OAuth</h3>
                <p>Ủy quyền qua Seller Central với Login with Amazon (LWA), phân quyền least-privilege theo vai trò Ops/Admin/Finance/Viewer. Hỗ trợ multi-marketplace US/EU/JP và multi-brand. Revoke ngay trong Seller Central, token mã hóa, cảnh báo trước khi hết hạn.</p>
              </div>
              <div className="landing-step reveal">
                <div className="landing-step-n">2</div>
                <h3>Đồng bộ dữ liệu vận hành theo SLA</h3>
                <p><b>Near real-time:</b> Orders & ORDER_CHANGE, Buy Box & Competitive Pricing. <b>Hourly:</b> FBA Inventory Ledger, FBA Inbound Shipments, Pricing. <b>Daily:</b> Sponsored Products/Brands/Display, Search Term Report, Settlement v2, FBA Reimbursement, Storage Fee & Aged Inventory Surcharge. Tự động backfill 30 ngày ngay sau kết nối.</p>
              </div>
              <div className="landing-step reveal">
                <div className="landing-step-n">3</div>
                <h3>Vận hành theo Action Center ưu tiên Revenue at Risk</h3>
                <p>Dashboard Action Center xếp hạng công việc theo tiền đang ảnh hưởng: Stockout Risk (Days of Cover thấp), Buy Box Lost, Suppressed/Stranded Listing, Campaign Out-of-Budget & Search Term cần phủ định, FBM Late Shipment Risk & Buyer Message quá SLA 24h. Xử lý xong tự động clear.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="departments" className="landing-section landing-departments">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Vận hành hằng ngày</div>
              <h2>Mỗi team nhìn đúng chỉ số chuyên môn, không chồng chéo</h2>
              <p>Phân quyền theo Brand/Marketplace: Ops chỉ thấy FBA & Buy Box, Ads chỉ thấy Sponsored & Search Term, Finance chỉ thấy Settlement & Reimbursement. Rõ trách nhiệm, không bỏ sót việc ảnh hưởng doanh thu.</p>
            </div>
            <div className="landing-dept-grid">
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">🛡️</div>
                <h3>Account Health Management</h3>
                <p>Theo dõi Account Health Rating (AHR), Policy Violation, Listing Deactivation, ODR, Late Shipment Rate, Valid Tracking Rate, Voice of Customer (VOC). Cảnh báo Required Action & Appeal trước khi bị hạn chế bán.</p>
                <span className="landing-dept-kpi">KPI: AHR, ODR, Policy Violation, Required Action</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">🏷️</div>
                <h3>Catalog & Listing Health</h3>
                <p>Phát hiện Suppressed Listing, Stranded Inventory, Incomplete Listing, Search Suppressed, Buy Box Suppressed. Xếp theo Revenue at Risk để ưu tiên fix listing đang kẹt tiền nhiều nhất.</p>
                <span className="landing-dept-kpi">KPI: Suppressed, Stranded, Revenue at Risk</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">💰</div>
                <h3>Pricing & Buy Box Intelligence</h3>
                <p>So sánh Competitive Price, theo dõi Buy Box Ownership, tính Net Margin sau Referral Fee + FBA Fulfillment Fee + Ads. Đề xuất đổi giá có Approval Workflow, rollback 1 chạm nếu sai.</p>
                <span className="landing-dept-kpi">KPI: Buy Box %, Competitive Price, Net Margin</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">📦</div>
                <h3>FBA Inventory & Replenishment</h3>
                <p>Quản lý FBA Inventory Ledger theo FC, tính Days of Cover, Sell-through Rate, Reorder Point & Safety Stock. Theo dõi Inbound Shipment (Working/Shipped/Receiving), cảnh báo Aged Inventory & Long-term Storage Fee.</p>
                <span className="landing-dept-kpi">KPI: Days of Cover, Sell-through, Inbound Status</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">📈</div>
                <h3>Sponsored Advertising & Search Term</h3>
                <p>Quản lý Sponsored Products/Brands/Display theo Campaign/Budget/Bid. Phân tích Search Term Report, Negative Keyword Harvesting, tối ưu ACOS/TACOS/ROAS, cảnh báo Out-of-Budget & Lost Impression Share.</p>
                <span className="landing-dept-kpi">KPI: ACOS, TACOS, ROAS, Search Term</span>
              </div>
              <div className="landing-dept reveal">
                <div className="landing-dept-ico">💬</div>
                <h3>Order Management & CX</h3>
                <p>Quản lý FBA/FBM Orders, đếm ngược Time to Ship, cảnh báo Late Shipment Risk, tập trung Buyer Message SLA 24h, phân tích Return Reason, theo dõi Feedback & Review ảnh hưởng ODR.</p>
                <span className="landing-dept-kpi">KPI: Late Shipment Rate, SLA 24h, Return Rate</span>
              </div>
            </div>
          </div>
        </section>

        <section id="modules" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Module</div>
              <h2>Một nền tảng duy nhất từ tổng quan đến chi tiết SKU/ASIN</h2>
              <p>Từ GMV xuống SKU, từ Campaign xuống Search Term, mọi chỉ số liên kết với nhau. Click từ doanh thu giảm là thấy ngay ASIN nào Buy Box Lost, Days of Cover bao nhiêu, ACOS đang đốt bao nhiêu.</p>
            </div>
            <div className="landing-modules-grid">
              <div className="landing-module-card reveal"><div className="m-ico">📊</div><div><h3>Operations Dashboard</h3><p>GMV, Units Sold, Conversion Rate, TACOS, Buy Box Ownership, Best Seller SKU/ASIN, Action Center theo Revenue at Risk — đỏ/vàng/xanh rõ ràng.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🛡️</div><div><h3>Account Health</h3><p>AHR Score, ODR, Late Shipment Rate, Valid Tracking Rate, Policy Violation, Deactivated ASIN, Appeal Tracker — Amazon báo gì thấy ngay.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🏷️</div><div><h3>Listing Management</h3><p>Suppressed, Stranded, Incomplete, Buy Box Suppressed, Price & FBA Stock, Bulk Edit với Approval Workflow trước khi push lên Seller Central.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">💲</div><div><h3>Profitability & Pricing</h3><p>Competitive Benchmark, Net Profit = Sales - Referral - FBA - Ads - Storage, SKU-level P&L, Price Change Approval & Rollback.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">📦</div><div><h3>FBA Inventory & Inbound</h3><p>FC-level Stock, Days of Cover Forecast, Reorder Suggestion, Inbound Shipment Tracking (Working/Shipped/Receiving), Aged Inventory Surcharge Alert.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🎯</div><div><h3>Advertising & Search Term</h3><p>Campaign &gt; Ad Group &gt; Keyword hierarchy, Search Term to Keyword mapping, Negative Harvesting, ACOS/TACOS/ROAS optimization, Budget Pacing.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">🧾</div><div><h3>Orders & Returns</h3><p>FBA/FBM Order Timeline, Time to Ship Countdown, Buyer Message Central, Return Reason Breakdown, Feedback/Review Monitoring ảnh hưởng ODR.</p></div></div>
              <div className="landing-module-card reveal"><div className="m-ico">💰</div><div><h3>Financial Reconciliation</h3><p>Settlement Report v2, Transaction Fees, FBA Reimbursement, Storage & Removal Fees, SKU-level Net Margin, Ad Spend Reconciliation — đối soát chính xác.</p></div></div>
            </div>
          </div>
        </section>

        <section id="security" className="landing-section">
          <div className="landing-wrap">
            <div className="landing-sec-head">
              <div className="landing-kicker">Bảo mật & Tuân thủ</div>
              <h2>Dữ liệu Seller là tài sản, tuân thủ chuẩn Amazon SP-API</h2>
              <p>Chỉ tích hợp chính thức qua SP-API & Advertising API, không scraping. Tuân thủ Amazon Data Protection Policy (DPP), Acceptable Use Policy (AUP) và PII Protection.</p>
            </div>
            <div className="landing-sec-grid">
              <div className="landing-sec-item reveal"><div className="s-ico">✓</div><div><h3>Amazon SP-API Official</h3><p>Kết nối trực tiếp SP-API & Ads API, không cào dữ liệu, không chia sẻ dữ liệu giữa các Brand/Marketplace, tuân thủ Amazon AUP.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🔑</div><div><h3>OAuth & Revoke Control</h3><p>LWA OAuth với least-privilege scopes, revoke ngay trong Seller Central, cảnh báo trước khi token hết hạn, hỗ trợ multi-marketplace.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🔒</div><div><h3>PII & Data Protection</h3><p>Không lưu Buyer PII, toàn bộ dữ liệu mã hóa at-rest & in-transit, tuân thủ DPP, sử dụng giới hạn cho mục đích vận hành đơn hàng.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🧑‍💻</div><div><h3>RBAC & Audit Log</h3><p>Phân quyền theo Brand/Marketplace/Module, mọi thay đổi giá/listing/campaign đều ghi audit log với before/after, người thực hiện và thời gian.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🗑️</div><div><h3>Data Retention & Deletion</h3><p>Tự động xóa dữ liệu khi disconnect theo Amazon DPP, không lưu dư thừa, chính sách lưu trữ minh bạch, có báo cáo xóa.</p></div></div>
              <div className="landing-sec-item reveal"><div className="s-ico">🛠️</div><div><h3>Built by Amazon Operators</h3><p>Team từng vận hành 10+ Brand Amazon, trải qua Buy Box Lost, FBA Stockout, ACOS spike, AHR drop — nên hiểu seller cần gì để giữ ODR và tăng Net Margin.</p></div></div>
            </div>
          </div>
        </section>

        <section id="about" className="landing-section">
          <div className="landing-wrap landing-split">
            <div className="landing-about">
              <div className="landing-kicker">Vì sao VEXIM?</div>
              <h2>Chúng tôi là Amazon Agency trước, rồi mới làm SaaS</h2>
              <p>VEXIM là đội vận hành Amazon tại Việt Nam, đang quản lý nhiều Brand trên US/EU. Hàng ngày xử lý Listing Optimization, Sponsored Ads Optimization (ACOS/TACOS/ROAS), FBA Replenishment theo Days of Cover, FBM Order Fulfillment và Settlement Reconciliation.</p>
              <p><b>VEXIM Ops</b> là hệ thống chúng tôi tự build để dùng trước — vì không tìm được tool nào đáp ứng đúng workflow Amazon: <b>nhìn vào là biết GMV, Net Margin, SKU nào đang Revenue at Risk và ai phải xử lý.</b></p>
              <ul>
                <li>✅ <b>Giảm Revenue at Risk:</b> tránh FBA Stockout, Buy Box Lost, Suppressed/Stranded Listing kéo dài, Campaign Out-of-Budget mất Impression Share.</li>
                <li>✅ <b>Nhìn rõ Net Margin thực:</b> sau khi trừ Referral Fee, FBA Fulfillment Fee, Storage Fee, Ad Spend và cộng FBA Reimbursement — biết chính xác SKU nào đang gánh P&L.</li>
                <li>✅ <b>Tăng tốc vận hành:</b> bỏ Excel đối chiếu thủ công, Action Center ưu tiên theo tiền, Price/Ads Approval nhanh, rollback 1 chạm nếu sai.</li>
                <li>✅ <b>Minh bạch với Brand Owner:</b> Client Portal riêng xem GMV, FBA Health, Ads Performance, Settlement — không cần hỏi qua chat mỗi ngày.</li>
              </ul>
            </div>
            <div className="landing-contact-card" id="contact">
              <h3>Demo trên dữ liệu thật?</h3>
              <p>Chúng tôi demo trực tiếp trên Seller Central & Ads Console của bạn, cho thấy Buy Box, FBA Days of Cover, Search Term và Settlement sẽ gọn lại thế nào với VEXIM Ops.</p>
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
          VEXIM Ops là sản phẩm độc lập, không liên kết với Amazon. “Amazon”, “Buy Box”, “FBA”, “Sponsored Products”, “ACOS”, “TACOS” là nhãn hiệu của Amazon.com, Inc. Chúng tôi tuân thủ SP-API Acceptable Use Policy và Data Protection Policy.
        </div>
      </footer>
    </>
  );
}
