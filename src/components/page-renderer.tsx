import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

/**
 * Loads a web page in an invisible WebView so its JavaScript runs, waits for the DOM to stop
 * changing, scrolls through it once to trigger lazy loading, then hands back the rendered
 * document. Mount it once on a screen and call `render(url)` through the ref.
 */

export type RenderedPage = { html: string; finalUrl: string; title: string };

export type PageRendererHandle = {
  render: (url: string) => Promise<RenderedPage>;
};

const TIMINGS = {
  totalMs: 45_000, // give up on the whole render after this
  quietMs: 1_200, // DOM must be unchanged for this long before it counts as settled
  maxSettleMs: 10_000, // stop waiting for quiet after this, whatever the page is doing
  scrollStepMs: 120,
  maxScrollSteps: 25,
  afterScrollMs: 800,
};

/** Runs inside the page: waits for mutations to stop, scrolls through, serialises the DOM. */
const CAPTURE_SCRIPT = `
(function () {
  var post = function (msg) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function waitForQuiet() {
    return new Promise(function (resolve) {
      var last = Date.now();
      var started = last;
      var observer = new MutationObserver(function () { last = Date.now(); });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      var timer = setInterval(function () {
        var now = Date.now();
        if (now - last >= ${TIMINGS.quietMs} || now - started >= ${TIMINGS.maxSettleMs}) {
          clearInterval(timer);
          observer.disconnect();
          resolve();
        }
      }, 200);
    });
  }
  async function scrollThrough() {
    var step = window.innerHeight || 800;
    for (var i = 1; i <= ${TIMINGS.maxScrollSteps}; i++) {
      window.scrollTo(0, i * step);
      await sleep(${TIMINGS.scrollStepMs});
      if (i * step >= document.documentElement.scrollHeight) break;
    }
    window.scrollTo(0, 0);
    await sleep(${TIMINGS.afterScrollMs});
  }
  function serialise() {
    var root = document.documentElement.cloneNode(true);
    var live = document.querySelectorAll("img");
    var copy = root.querySelectorAll("img");
    for (var i = 0; i < live.length && i < copy.length; i++) {
      if (live[i].currentSrc) copy[i].setAttribute("src", live[i].currentSrc);
    }
    var junk = root.querySelectorAll("script, noscript, iframe");
    for (var j = 0; j < junk.length; j++) junk[j].parentNode.removeChild(junk[j]);
    return "<!DOCTYPE html>\\n" + root.outerHTML;
  }
  (async function () {
    try {
      await waitForQuiet();
      await scrollThrough();
      await waitForQuiet();
      post({ ok: true, html: serialise(), url: location.href, title: document.title });
    } catch (e) {
      post({ ok: false, error: String(e && e.message || e) });
    }
  })();
})();
true;
`;

type Job = {
  url: string;
  resolve: (page: RenderedPage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
};

export const PageRenderer = forwardRef<PageRendererHandle>(function PageRenderer(_props, ref) {
  const { width, height } = useWindowDimensions();
  const webViewRef = useRef<WebView>(null);
  const job = useRef<Job | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  const finish = (fn: (j: Job) => void) => {
    const current = job.current;
    if (!current || current.settled) return;
    current.settled = true;
    clearTimeout(current.timer);
    job.current = null;
    setUrl(null);
    fn(current);
  };

  useImperativeHandle(ref, () => ({
    render: (target: string) =>
      new Promise<RenderedPage>((resolve, reject) => {
        if (job.current) {
          reject(new Error("Another page is still rendering"));
          return;
        }
        const timer = setTimeout(
          () => finish((j) => j.reject(new Error("Timed out waiting for the page to render"))),
          TIMINGS.totalMs,
        );
        job.current = { url: target, resolve, reject, timer, settled: false };
        setUrl(target);
      }),
  }));

  const onMessage = (event: WebViewMessageEvent) => {
    let data: { ok: boolean; html?: string; url?: string; title?: string; error?: string };
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (data.ok && data.html) {
      finish((j) => j.resolve({ html: data.html!, finalUrl: data.url || j.url, title: data.title || "" }));
    } else {
      finish((j) => j.reject(new Error(data.error || "The page could not be captured")));
    }
  };

  if (!url) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width, height, opacity: 0 }}>
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        style={{ width, height }}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction
        onLoadEnd={() => webViewRef.current?.injectJavaScript(CAPTURE_SCRIPT)}
        onError={(e) => finish((j) => j.reject(new Error(e.nativeEvent.description || "The page could not be loaded")))}
        onHttpError={(e) =>
          finish((j) => j.reject(new Error(`The page could not be loaded (HTTP ${e.nativeEvent.statusCode})`)))
        }
        onMessage={onMessage}
      />
    </View>
  );
});
