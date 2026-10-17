// Paste into the DevTools console of a logged-in Yandex Music TRACK page (music.yandex.ru/…/track/N).
// Read-only: lists clickable elements and how close each one's React data is to the page's
// track (hops; -1 = never). It copies the JSON to the clipboard. Used when Yandex changes the
// markup and MusicBridge's startTrack() stops finding the play button.
(() => {
  const id = location.pathname.match(/\/track\/(\d+)/)?.[1];
  const fiber = (el) => el[Object.keys(el).find((k) => k.startsWith("__reactFiber$"))];
  const carries = (v, d = 3, seen = new Set()) => {
    try {
      if (!v || typeof v !== "object" || d < 0 || seen.has(v) || v.$$typeof) return false;
      seen.add(v);
      if (String(v.id) === id) return true;
      return Object.values(v).slice(0, 40).some((x) => x && typeof x === "object" && carries(x, d - 1, seen));
    } catch { return false; }
  };
  const hops = (el) => {
    let f = fiber(el);
    for (let h = 0; f && h <= 15; h++, f = f.return) if (carries(f.memoizedProps)) return h;
    return -1;
  };
  const out = [...document.querySelectorAll('button, [role="button"], a[href*="play"]')].map((el) => ({
    tag: el.tagName.toLowerCase(),
    aria: el.getAttribute("aria-label") || "",
    pressed: el.getAttribute("aria-pressed") || "",
    test: el.getAttribute("data-test-id") || el.getAttribute("data-testid") || "",
    cls: String(el.className).slice(0, 80),
    text: (el.innerText || "").trim().slice(0, 25),
    hops: id ? hops(el) : -1,
  })).filter((c) => c.hops >= 0 || /play|pause|listen|слуша|воспроизв|пауз/i.test(Object.values(c).join(" ")));
  const json = JSON.stringify({ url: location.href, track: id, n: out.length, buttons: out }, null, 1);
  copy(json);
  console.log(json);
  return `copied ${out.length} candidates`;
})();
