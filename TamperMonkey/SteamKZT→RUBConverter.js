// ==UserScript==
// @name         Steam KZT→RUB Converter (RU Region Add-on)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Показывает цены Steam KZ в рублях + конвертация KZT→RUB. Работает в обоих регионах.
// @match        https://store.steampowered.com/*
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
// ==/UserScript==

(function () {
    'use strict';

    const RUB_RATE_API = "https://api.exchangerate.host/latest?base=KZT&symbols=RUB";

    async function getExchangeRate() {
        try {
            const response = await fetch(RUB_RATE_API);
            const data = await response.json();
            return data.rates.RUB;
        } catch (e) {
            console.error("Ошибка получения курса KZT→RUB:", e);
            return null;
        }
    }

    async function getKZPrice(appid) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=kz&filters=price_overview`,
                onload: function (response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        if (!data[appid]?.success) return resolve(null);
                        resolve(data[appid].data.price_overview);
                    } catch {
                        resolve(null);
                    }
                }
            });
        });
    }

    function getAppIdFromUrl() {
        const match = location.pathname.match(/\/app\/(\d+)/);
        return match ? match[1] : null;
    }

    function insertConvertedPrice(element, text) {
        const span = document.createElement("span");
        span.style.color = "#8fbc8f";
        span.style.marginLeft = "6px";
        span.textContent = text;
        element.appendChild(span);
    }

    async function main() {
        const rate = await getExchangeRate();
        if (!rate) return;

        const priceElement = document.querySelector(".game_purchase_price, .discount_final_price");
        if (!priceElement) return;

        const appid = getAppIdFromUrl();
        if (!appid) return;

        const priceText = priceElement.innerText.replace(/\s/g, "");

        // ========= 1. Если регион KZ — обычная конвертация =========
        if (priceText.includes("₸")) {
            const kzt = parseInt(priceText);
            const rub = Math.round(kzt * rate);
            insertConvertedPrice(priceElement, `(${rub} ₽)`);
        }

        // ========= 2. Если регион RU — подгружаем настоящую цену KZ =========
        if (priceText.includes("₽")) {
            const kzPriceInfo = await getKZPrice(appid);
            if (!kzPriceInfo) return;

            const kzt = kzPriceInfo.final / 100; // Steam API даёт цену *100
            const rubKZ = Math.round(kzt * rate);

            insertConvertedPrice(priceElement, `(${rubKZ} ₽ KZ)`);
        }
    }

    main();
})();
