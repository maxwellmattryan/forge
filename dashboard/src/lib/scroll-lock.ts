// The page under the drawer, a dialog or the palette does not scroll. html's scrollbar-gutter: stable alone does not hold
// the page still: Chromium ignores it under the ::-webkit-scrollbar styles (style.css), so hiding the overflow drops the
// rail and widens the page. The lock pads the root, and the fixed status bar, by exactly the width the lock took.

let holders = 0;

/** Locks the page's scroll until the returned release runs; nested locks share one, so any order of release is safe. */
export function lockScroll(): () => void {
  const html = document.documentElement;
  if (holders++ === 0) {
    const before = html.clientWidth;
    html.style.overflow = 'hidden';
    const gap = Math.max(0, html.clientWidth - before);
    if (gap > 0) {
      html.style.paddingRight = `${gap}px`;
      html.style.setProperty('--scroll-lock-gap', `${gap}px`);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders > 0) return;
    html.style.overflow = '';
    html.style.paddingRight = '';
    html.style.removeProperty('--scroll-lock-gap');
  };
}
