const image = document.getElementById('image');
const error = document.getElementById('error');
const fail = () => { image.hidden = true; error.hidden = false; };
image.addEventListener('error', fail);
try {
  const url = new URL(new URLSearchParams(location.search).get('src'));
  if (url.protocol !== 'nanobot:' || url.host !== 'desktop' || url.username || url.password
      || !/^\/api\/media\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('无效附件');
  image.src = url.href;
} catch { fail(); }
