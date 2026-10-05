// Renders rotating AliExpress product ads into every <div class="ae-ad-slot"></div>
(function () {
  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function card(p) {
    var title = p.title.length > 80 ? p.title.slice(0, 77) + "..." : p.title;
    var orig = p.origPrice && p.origPrice !== p.price
      ? ' <span style="color:#888;text-decoration:line-through;font-size:0.8rem;">$' + esc(p.origPrice) + "</span>" : "";
    var disc = p.discount
      ? ' <span style="color:#e53935;font-size:0.8rem;font-weight:bold;">' + esc(p.discount) + " OFF</span>" : "";
    return '<div style="margin:15px auto;max-width:700px;padding:14px 18px;background:#fff;border:1px solid #ddd;border-left:3px solid #343a44;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.08);font-family:inherit;text-align:left;">' +
      '<div style="font-size:0.6rem;letter-spacing:1px;text-transform:uppercase;color:#999;text-align:right;margin-bottom:3px;">Ad</div>' +
      '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">' +
      '<a href="' + esc(p.link) + '" target="_blank" rel="sponsored noopener" style="flex-shrink:0;"><img src="' + esc(p.image) + '" alt="' + esc(title) + '" width="90" height="90" loading="lazy" style="display:block;width:90px;height:90px;object-fit:contain;background:#fff;border:1px solid #eee;border-radius:6px;"></a>' +
      '<div style="flex:1;min-width:180px;">' +
      '<div style="font-weight:bold;color:#222;margin-bottom:3px;font-size:0.9rem;">' + esc(title) + "</div>" +
      '<div style="font-size:0.95rem;"><span style="color:#1a9c46;font-weight:bold;">$' + esc(p.price) + "</span>" + orig + disc + "</div>" +
      "</div>" +
      '<a href="' + esc(p.link) + '" target="_blank" rel="sponsored noopener" style="background:#e53935;color:#fff;padding:9px 20px;border-radius:5px;text-decoration:none;font-size:0.85rem;font-weight:bold;white-space:nowrap;">Shop Deal &rarr;</a>' +
      "</div></div>";
  }

  var slots = document.querySelectorAll(".ae-ad-slot");
  if (!slots.length) return;

  fetch("/api/ads?count=" + slots.length)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var products = (data && data.products) || [];
      for (var i = 0; i < slots.length && i < products.length; i++) {
        slots[i].innerHTML = card(products[i]);
      }
    })
    .catch(function () { /* ads are optional — fail silently */ });
})();
