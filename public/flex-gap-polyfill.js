/**
 * Flexbox gap polyfill for Safari 13 (macOS 10.15 Catalina)
 *
 * Safari 13 supports CSS Grid gap but NOT flexbox gap.
 * This polyfill detects flex containers with gap and applies
 * equivalent margins to their children.
 *
 * Uses MutationObserver to handle dynamically added elements.
 */
(function () {
  'use strict';

  // --- Feature detection ---
  // Check if CSS.supports is available and if flexbox gap is supported.
  // Safari 13 has CSS.supports but doesn't support gap in flex context.
  var needsPolyfill = false;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    // CSS.supports('gap', '1px') returns true on Safari 13 (because grid supports gap)
    // CSS.supports('flex-gap', '1px') is non-standard but some browsers recognize it.
    // The real check: try applying gap to a flex element and see if it takes effect.
    needsPolyfill = !CSS.supports('row-gap', '1px');
    if (!needsPolyfill) {
      // row-gap exists in Safari 13 for grid. Test flex-specific gap.
      var testEl = document.createElement('div');
      testEl.style.display = 'flex';
      testEl.style.gap = '1px';
      // Create two child boxes to measure gap effect
      var c1 = document.createElement('div');
      var c2 = document.createElement('div');
      c1.style.width = c2.style.width = '10px';
      c1.style.height = c2.style.height = '10px';
      testEl.appendChild(c1);
      testEl.appendChild(c2);
      document.documentElement.appendChild(testEl);
      // If gap works, c2's offsetLeft should be c1's offsetLeft + 10 (width) + 1 (gap) = offsetLeft + 11
      var gapWorks = (c2.offsetLeft - c1.offsetLeft) === 11;
      document.documentElement.removeChild(testEl);
      needsPolyfill = !gapWorks;
    }
  } else {
    needsPolyfill = true; // Very old browser, assume no support
  }

  if (!needsPolyfill) return;

  // Mark symbol for tracking processed elements
  var MARK = '__fgp_' + Math.random().toString(36).slice(2, 8);

  /**
   * Apply gap-as-margin to a single flex container's children.
   */
  function applyGap(el) {
    var cs = getComputedStyle(el);
    var display = cs.display;
    if (display !== 'flex' && display !== 'inline-flex') return;

    var gap = cs.gap || '';
    var rowGap = cs.rowGap || '';
    var colGap = cs.columnGap || '';

    // Parse gap values
    var gapRow = 0, gapCol = 0;
    if (gap && gap !== 'normal' && gap !== '0px') {
      var parts = gap.split(/\s+/);
      gapRow = parseFloat(parts[0]) || 0;
      gapCol = parts.length > 1 ? (parseFloat(parts[1]) || 0) : gapRow;
    }
    if (rowGap && rowGap !== 'normal' && rowGap !== '0px') {
      gapRow = parseFloat(rowGap) || gapRow;
    }
    if (colGap && colGap !== 'normal' && colGap !== '0px') {
      gapCol = parseFloat(colGap) || gapCol;
    }

    if (gapRow === 0 && gapCol === 0) return;

    var direction = cs.flexDirection || 'row';
    var isRow = direction.indexOf('row') !== -1;

    var children = el.children;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType !== 1) continue;

      // Record which container processed this child
      var prevMark = child[MARK];
      if (prevMark === el) continue; // already done for this container

      // Clean up margins from previous container if re-parented
      if (prevMark) {
        child.style.removeProperty('margin-left');
        child.style.removeProperty('margin-top');
      }
      child[MARK] = el;

      if (i > 0) {
        if (isRow) {
          child.style.setProperty('margin-left', gapCol + 'px', 'important');
        } else {
          child.style.setProperty('margin-top', gapRow + 'px', 'important');
        }
      } else {
        // First child: ensure no leftover margin from polyfill
        child.style.removeProperty('margin-left');
        child.style.removeProperty('margin-top');
      }
    }

    el[MARK] = true;
  }

  /**
   * Scan a subtree for flex containers with gap.
   */
  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    // Check root itself
    var cs = getComputedStyle(root);
    if ((cs.display === 'flex' || cs.display === 'inline-flex') &&
        cs.gap && cs.gap !== 'normal' && cs.gap !== '0px') {
      applyGap(root);
    }
    // Check descendants
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var ecs = getComputedStyle(el);
      if ((ecs.display === 'flex' || ecs.display === 'inline-flex') &&
          ecs.gap && ecs.gap !== 'normal' && ecs.gap !== '0px') {
        applyGap(el);
      }
    }
  }

  /**
   * Debounced full scan.
   */
  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = requestAnimationFrame(function () {
      scan(document.documentElement);
      scanTimer = null;
    });
  }

  // Initial scan
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      scheduleScan();
    });
  } else {
    scheduleScan();
  }

  // MutationObserver for dynamic content (React renders)
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType === 1) {
            // Scan the added subtree
            scan(node);
            // Also scan parent (in case a child was inserted into a flex container)
            var parent = node.parentElement;
            if (parent) {
              var pcs = getComputedStyle(parent);
              if ((pcs.display === 'flex' || pcs.display === 'inline-flex') &&
                  pcs.gap && pcs.gap !== 'normal' && pcs.gap !== '0px') {
                applyGap(parent);
              }
            }
          }
        }
      } else if (m.type === 'attributes' && m.attributeName === 'style') {
        // Style changed — might affect flex/gap
        var target = m.target;
        if (target.nodeType === 1) {
          var tcs = getComputedStyle(target);
          if ((tcs.display === 'flex' || tcs.display === 'inline-flex') &&
              tcs.gap && tcs.gap !== 'normal' && tcs.gap !== '0px') {
            applyGap(target);
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });

  console.log('[FlexGapPolyfill] Active — Safari 13 flexbox gap fallback enabled');
})();
