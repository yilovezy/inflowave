/**
 * Safari 13 / Legacy WebKit detection — adds `safari13` class to <html> for CSS fallback rules.
 * Uses Feature Detection first, then UA detection fallback.
 * Loads before page render so CSS rules apply immediately.
 */
(function () {
  'use strict';
  try {
    // Feature detection: Safari 13 (and older WebKit) does NOT support CSS `inset` (added in Safari 14.1)
    var supportsInset = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('inset', '0px');

    // UA fallback: Detect macOS 10.15 / Safari 13.x / WebKit on Catalina
    var ua = navigator.userAgent || '';
    var isLegacyWebKit = /Mac OS X 10_15|Version\/13\.\d/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua);

    if (!supportsInset || isLegacyWebKit) {
      document.documentElement.classList.add('safari13');
    }
  } catch (e) {
    document.documentElement.classList.add('safari13');
  }
})();
