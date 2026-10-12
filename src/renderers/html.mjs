const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function renderHtml(project, layouts, images) {
  const sections = layouts.map((layout, index) => {
    const source = project.slides[index];
    const photoElements = layout.elements.filter(element => element.type === 'image' && element.assetId !== project.brand?.logoAssetId);
    const logo = images.get(project.brand?.logoAssetId);
    const lead = photoElements.length ? images.get(photoElements[0].assetId) : null;
    const orientation = lead && lead.width / lead.height < 1 ? 'portrait' : 'landscape';
    const imageMarkup = photoElements.map(element => {
      const asset = images.get(element.assetId);
      return `<figure><img src="data:${asset.mediaType};base64,${asset.bytes.toString('base64')}" alt="${esc(element.alt)}" width="${asset.width}" height="${asset.height}" loading="${index === 0 ? 'eager' : 'lazy'}" decoding="async"></figure>`;
    }).join('');
    const body = Array.isArray(source.body) ? source.body.join('\n') : source.body;
    return `<section class="page ${esc(layout.kind)} ${orientation}" aria-labelledby="heading-${index}">${imageMarkup ? `<div class="visual count-${photoElements.length}">${imageMarkup}</div>` : ''}<header class="copy"><h${index === 0 ? '1' : '2'} id="heading-${index}">${esc(source.title || project.title)}</h${index === 0 ? '1' : '2'}>${body ? `<p class="body">${esc(body)}</p>` : ''}${source.caption ? `<p class="caption">${esc(source.caption)}</p>` : ''}</header>${logo ? `<img class="logo" src="data:${logo.mediaType};base64,${logo.bytes.toString('base64')}" alt="品牌标识" width="${logo.width}" height="${logo.height}">` : ''}</section>`;
  }).join('\n');
  const font = String(project.brand?.fontFamily || 'Microsoft YaHei').replace(/[^\p{L}\p{N} _-]/gu, '');
  const accent = /^#[0-9a-f]{6}$/i.test(project.brand?.accent ?? '') ? project.brand.accent : '#53695D';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(project.title)}</title><style>
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:#fff;color:#202020;font-family:'${font}',sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1680px;margin:auto}
.page{position:relative;margin:0;padding:56px 4.2% 70px;display:grid;grid-template-columns:minmax(0,1fr);gap:24px}
.page+.page{border-top:1px solid #e8e8e8}
.visual,figure{margin:0;min-width:0}
.visual{display:grid;gap:24px;align-items:start}
.visual img{display:block;width:100%;height:auto;object-fit:contain}
.copy{min-width:0}
h1,h2{font-size:clamp(23px,2.1vw,32px);font-weight:400;line-height:1.4;letter-spacing:0;white-space:pre-line;overflow-wrap:anywhere;margin:0;color:${accent}}
.body{font-size:clamp(16px,1.25vw,19px);line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;color:#555;margin:14px 0 0}
.caption{font-size:12px;line-height:1.7;color:#747474;white-space:pre-wrap;overflow-wrap:anywhere;margin:18px 0 0}
.logo{width:112px;height:28px;object-fit:contain;object-position:left center;margin-top:8px;grid-column:1/-1}
.hero .copy,.gallery .copy{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.55fr);column-gap:40px;align-items:start}
.hero .body,.gallery .body{margin:2px 0 0}
.hero .caption,.gallery .caption{grid-column:1/-1;margin-top:16px}
.split.portrait,.cover.portrait{grid-template-columns:minmax(0,2.5fr) minmax(220px,1fr);column-gap:7%;align-items:end;padding-left:8%;padding-right:8%}
.split.portrait .copy,.cover.portrait .copy{padding-bottom:24px}
.split.landscape,.cover.landscape{grid-template-columns:minmax(0,3fr) minmax(220px,1fr);column-gap:5%;align-items:end}
.plan{grid-template-columns:minmax(0,1fr);justify-items:center;background:#fff;padding-top:64px}
.plan.portrait .visual,.plan.portrait .copy{width:min(100%,680px)}
.plan.landscape .visual,.plan.landscape .copy{width:100%}
.plan .copy{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);column-gap:32px;align-items:start}
.plan .body{margin:2px 0 0}
.plan .caption{grid-column:1/-1;margin-top:16px}
.count-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.count-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.text{padding:100px 8%;min-height:480px;align-content:center}
.text .copy{max-width:850px}
.text h1,.text h2{font-size:clamp(30px,3.5vw,48px)}
.text .body{max-width:720px;margin-top:24px}
@media(max-width:740px){
 .page,.split.portrait,.cover.portrait,.split.landscape,.cover.landscape,.plan{padding:28px 5% 42px;grid-template-columns:minmax(0,1fr);gap:20px}
 .hero .copy,.gallery .copy,.plan .copy{display:block}
 .split.portrait .copy,.cover.portrait .copy{padding:0}
 .hero .body,.gallery .body,.plan .body{margin-top:10px}
 .body{font-size:16px;line-height:1.8;margin-top:10px}
 .caption,.hero .caption,.gallery .caption,.plan .caption{font-size:12px;margin-top:12px}
 .count-2,.count-3{grid-template-columns:minmax(0,1fr);gap:18px}
 .text{padding-top:60px;padding-bottom:60px;min-height:360px}
 .logo{width:96px;height:24px}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{.page{break-after:page;border:0}.visual img{max-height:85vh;width:auto;max-width:100%}}
</style></head><body><main>${sections}</main></body></html>`;
}
