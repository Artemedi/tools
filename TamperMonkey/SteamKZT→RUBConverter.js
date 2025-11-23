// ==UserScript==
// @name         Steam KZT → RUB Converter with Lazy Load
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Steam KZT → RUB, работает с подгружаемым содержимым в ленте (wishlist, каталоги и пр.)
// @match        https://store.steampowered.com/*
// @grant        none
// ==/UserScript==

(function() {
  'use strict';
  const RUB_MARKER = " (~";
  let KZT_TO_RUB = null;
  const ACCESS_KEY = "0dd78cddca06c2e4b15e40a4fd15fbc5";
  const API_URL = `https://api.exchangerate.host/convert?from=KZT&to=RUB&amount=1&access_key=${ACCESS_KEY}`;

  function convertTextNode(node) {
      if (node.nodeValue.includes(RUB_MARKER) || !KZT_TO_RUB) return;
      const regex = /(\d{1,3}(?:[ \u00A0]\d{3})*(?:[\.,]\d+)?|\d+[\.,]?\d*)\s*₸/g;
      node.nodeValue = node.nodeValue.replace(regex, (match, number) => {
          const cleanNum = number.replace(/[\u00A0 ]/g, '').replace(',', '.');
          const value = parseFloat(cleanNum);
          if (isNaN(value)) return match;
          const rub = Math.round(value * KZT_TO_RUB);
          return `${number}₸ (~${rub}₽)`;
      });
  }

  function walkAndConvert(node) {
      if (node.nodeType === Node.TEXT_NODE) {
          if (node.nodeValue && node.nodeValue.includes("₸")) convertTextNode(node);
      } else {
          for (let i = 0; i < node.childNodes.length; i++) {
              walkAndConvert(node.childNodes[i]);
          }
      }
  }

  function scan() {
      walkAndConvert(document.body);
  }

  fetch(API_URL)
    .then(r => r.json())
    .then(data => {
        KZT_TO_RUB = (
            data && (typeof data.result === 'number')
                ? data.result
                : (data.info && data.info.quote)
        );
        if (!KZT_TO_RUB) KZT_TO_RUB = 0.15185;

        scan();

        // MutationObserver — слежение за изменениями
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                if (mutation.addedNodes && mutation.addedNodes.length) {
                    mutation.addedNodes.forEach(walkAndConvert);
                }
            });
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });

        // EXTRA: раз в 2 секунды сканируем всю страницу (на случай, если observer что-то не заметил)
        setInterval(scan, 2000);
    })
    .catch(() => {
        // fallback на захардкоженный курс
        KZT_TO_RUB = 0.15185;
        scan();
        setInterval(scan, 2000);
    });

})();
