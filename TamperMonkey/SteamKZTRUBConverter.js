// ==UserScript==
// @name         Steam RU/KZ Price Comparator + KZT→RUB Converter
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Показывает цену KZ на RU страницах Steam + процент разницы. На KZ страницах конвертирует KZT → RUB.
// @match        https://store.steampowered.com/*
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
// ==/UserScript==

(function() {
    'use strict';

    const RATE_API = "https://api.exchangerate.host/latest?base=KZT&symbols=RUB";
    let kztToRub = 0;

    // Получаем курс
    GM_xmlhttpRequest({
        method: "GET",
        url: RATE_API,
        onload: res => {
            try {
                kztToRub = JSON.parse(res.responseText).rates.RUB;
            } catch(e) { console.error("Rate error:", e); }
        }
    });

    /** Получение цены KZ через API Steam */
    function getKZPrice(appId, callback) {
        GM_xmlhttpRequest({
            method: "GET",
            url: `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=kz&filters=price_overview`,
            onload: res => {
                try {
                    let data = JSON.parse(res.responseText)[appId];
                    if (!data.success) return callback(null);

                    callback(data.data.price_overview.final); // цена в тиынах
                } catch (e) {
                    console.error("KZ price error:", e);
                    callback(null);
                }
            }
        });
    }

    /** Применение в DOM */
    function processPriceElement(el) {
        if (!el) return;
        if (!kztToRub) return; // курс ещё не загружен

        const text = el.textContent.trim();

        // Определяем регион по валюте
        const isKZ = text.includes("₸");
        const isRU = text.includes(" p") || text.includes("₽");

        // KZ → RUB
        if (isKZ) {
            let kzt = parseInt(text.replace(/\D/g, ""));
            if (!kzt) return;

            let rub = Math.round(kzt * kztToRub);
            appendInfo(el, `≈ ${rub} ₽`);
        }

        // RU → берём цену KZ из API
        if (isRU) {
            const appId = getAppId();
            if (!appId) return;

            getKZPrice(appId, kzPrice => {
                if (!kzPrice) return;

                let kzRub = Math.round((kzPrice / 100) * kztToRub);
                let ruRub = parseInt(text.replace(/\D/g, ""));
                let diff = Math.round(((ruRub - kzRub) / ruRub) * 100);

                appendInfo(el, ` | KZ: ${kzRub} ₽ (${diff}% разница)`);
            });
        }
    }

    function appendInfo(el, text) {
        if (el.dataset.enhanced) return;
        el.dataset.enhanced = "1";

        const span = document.createElement("span");
        span.style.color = "#9ae2a8";
        span.style.fontSize = "14px";
        span.textContent = " " + text;
        el.appendChild(span);
    }

    function getAppId() {
        let m = location.href.match(/app\/(\d+)/);
        return m ? m[1] : null;
    }

    /** Observer Steam DOM */
    const observer = new MutationObserver(() => {
        document.querySelectorAll(".game_purchase_price, .discount_final_price").forEach(processPriceElement);
    });

    observer.observe(document.body, { childList: true, subtree: true });
})();
