/** Model intent is a proposal. Destructive/paid follow-up work needs a clear user request. */
export function resolveConversationAction(proposed, message, slides = []) {
  const reply = (reason = '') => ({action:'reply',reason});
  if (!proposed || !['reply','produce','revise','export'].includes(proposed.action)) return reply();
  if (proposed.action === 'reply') return reply();
  const relevantMessage = message.replace(/(?:其他|其它|其余)(?:的)?页(?:面)?[^，,。；;！？\n]{0,12}(?:不(?:要|用)?改|保持不变)/g,'');
  const negativeAction = proposed.action === 'produce' ? '(?:制[作做]|生成|做|排版)' : proposed.action === 'export' ? '(?:导出|输出|下载)' : '(?:改|调整|替换|删)';
  if (new RegExp('(?:不要|别|不用|不需要|暂不|先不|停止|取消)[^，,。；;！？\\n]{0,18}'+negativeAction).test(relevantMessage)
      || /(?:do not|don't|never|stop|cancel)\s+(?:make|create|generate|export|revise|edit)/i.test(relevantMessage)) return reply('已保留当前内容，本轮只讨论。');
  if (/(?:怎么|如何|为什么|是否|能否|能不能|可不可以|可以吗|会不会)|\?$|？$/.test(message)
      && !/(?:请|直接|现在|开始|帮我|替我|给我)(?:[^。！？\n]{0,12})(?:制[作做]|生成|做成|做一|编排|导出|修改|改成|改为)/.test(message)) return reply();
  if (proposed.action === 'produce' && !/(?:制作|生成|做成|做一|做个|做\s*(?:PPT|演示|汇报|网页|网站|杂志)|(?:给我|出)一(?:份|套|版)|开始做|开始吧|开始制作|按这个来|就这样做|出稿|编排|重排|重做|create|generate|make)/i.test(message)) return reply();
  if (proposed.action === 'export' && !/(?:导出|下载|输出|转成|转为|打包|export|download)/i.test(message)) return reply();
  if (proposed.action === 'revise' && !/(?:改|调整|替换|放大|缩小|删|去掉|增加|简短|压短|edit|revise|change)/i.test(message)) return reply();
  const requestedFormats = [...new Set(Array.isArray(proposed.formats) ? proposed.formats.filter(item => ['pptx','web','images'].includes(item)) : [])];
  const formats = (requestedFormats.length ? requestedFormats : ['pptx','web','images']).filter(format => {
    const media = format === 'pptx' ? '(?:PPTX?|演示文稿)' : format === 'web' ? '(?:网页|网站|HTML)' : '(?:图片|PNG|JPG)';
    return !new RegExp('(?:不要|不用|不需要|暂不|先不)[^，,。；;！？\\n]{0,12}'+media,'i').test(message);
  });
  if (!formats.length) return reply('已保留当前内容。请说明希望得到哪种文件。');
  if (proposed.action === 'revise') {
    const numerals = {'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10};
    const number = value => /^\d+$/.test(value) ? Number(value) : value.includes('十') ? (numerals[value.split('十')[0]] || 1) * 10 + (numerals[value.split('十')[1]] || 0) : numerals[value];
    const positions = [...message.matchAll(/第\s*(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*页/g)].map(match => number(match[1]));
    const ids = new Set(positions.map(position => slides[position - 1]?.id).filter(Boolean));
    if (positions.some(position => !slides[position - 1]) || new Set(positions).size > 1) return reply('请明确这次要修改的一个页码，当前页面已保留。');
    for (const slide of slides) if (message.includes(slide.id) || (slide.title && message.includes(slide.title))) ids.add(slide.id);
    if (ids.size !== 1) return reply('请告诉我要改第几页，以及希望怎样修改。');
    const slideId = [...ids][0];
    if (proposed.slideId && proposed.slideId !== slideId) return reply('你提到的页码与识别结果不一致，请再明确要修改的那一页。');
    return {action:'revise',slideId,formats};
  }
  return {action:proposed.action,formats};
}
