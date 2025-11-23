// ==UserScript==
// @name         Steam RU/KZ Price Comparator (Text-Only Mode v6.0)
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Сравнивает цены RU/KZ. Использует только текстовые узлы (без HTML тегов), чтобы работать вместе со Steam Inventory Helper в Chrome.
// @author       You
// @match        https://store.steampowered.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.exchangerate-api.com
// @connect      store.steampowered.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const RATE_API = "https://api.exchangerate-api.com/v4/latest/KZT";
    let kztToRub = 0;
    const priceCache = {};
    let scanTimeout = null;

    // --- 1. Загрузка курса ---
    function init() {
        GM_xmlhttpRequest({
            method: "GET",
            url: RATE_API,
            onload: res => {
                try {
                    const data = JSON.parse(res.responseText);
                    kztToRub = data.rates.RUB;
                    console.log(`[SteamPrice] Курс: 100 KZT = ${(kztToRub * 100).toFixed(2)} RUB`);
                    // Даем браузеру и другим расширениям прогрузиться
                    setTimeout(() => {
                        runScan();
                        startObserver();
                    }, 1000);
                } catch(e) { console.error("[SteamPrice] Ошибка курса:", e); }
            }
        });
    }

    // --- 2. API Запрос (anonymous: true важно для RU региона) ---
    function getRegionalPrice(appId, regionCC, callback) {
        const cacheKey = `${appId}_${regionCC}`;
        if (priceCache[cacheKey] !== undefined) return callback(priceCache[cacheKey]);

        // Очередь запросов с debounce
        setTimeout(() => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${regionCC}&filters=price_overview`,
                anonymous: true,
                onload: res => {
                    try {
                        const json = JSON.parse(res.responseText);
                        if (json[appId] && json[appId].success && json[appId].data.price_overview) {
                            const price = json[appId].data.price_overview.final / 100;
                            priceCache[cacheKey] = price;
                            callback(price);
                        } else {
                            priceCache[cacheKey] = null;
                            callback(null);
                        }
                    } catch (e) {
                        priceCache[cacheKey] = null;
                        callback(null);
                    }
                },
                onerror: () => callback(null)
            });
        }, 100);
    }

    // --- 3. Безопасное добавление текста (Метод старого скрипта) ---
    function appendTextToNode(el, textString) {
        // Проверяем, не добавлен ли уже текст, чтобы не дублировать
        if (el.innerText.includes(" | ") || el.innerText.includes("📉") || el.innerText.includes("📈")) return;

        // Мы не создаем div/span, мы создаем текстовый узел.
        // Для SIH это выглядит как просто продолжение текста цены.
        const textNode = document.createTextNode(" " + textString);
        el.appendChild(textNode);
    }

    // --- 4. Основная логика ---
    function processPriceElement(el) {
        // Если уже обработан нашим скриптом
        if (el.dataset.spTextProcessed === "1") return;
        
        const rawText = el.innerText || "";
        const text = rawText.toLowerCase();

        // Определение валюты
        const isKZ = text.includes("₸");
        const isRU = text.includes("руб") || text.includes("rub") || text.includes("₽") || text.includes("р.");

        if (!isKZ && !isRU) return;

        // Чистим цену для парсинга
        const digits = rawText.replace(/\D/g, "");
        if (!digits) return;
        const currentPriceVal = parseInt(digits, 10);
        
        const appId = getAppId(el);
        if (!appId) return;

        // Помечаем элемент
        el.dataset.spTextProcessed = "1";

        // Логика RU -> KZ
        if (isRU) {
            getRegionalPrice(appId, 'kz', (kzPriceInTenge) => {
                if (!el.isConnected || !kzPriceInTenge) return;

                let kzPriceInRub = Math.round(kzPriceInTenge * kztToRub);
                let diff = 0;
                let icon = "";
                let info = "";

                if (currentPriceVal > kzPriceInRub) {
                     // В KZ дешевле
                     diff = Math.round(((currentPriceVal - kzPriceInRub) / currentPriceVal) * 100);
                     icon = "📉"; // График вниз (цена ниже)
                     info = `| KZ: ${kzPriceInRub}₽ (-${diff}%) ${icon}`;
                } else {
                     // В KZ дороже
                     diff = Math.round(((kzPriceInRub - currentPriceVal) / currentPriceVal) * 100);
                     icon = "📈"; // График вверх (цена выше)
                     info = `| KZ: ${kzPriceInRub}₽ (+${diff}%) ${icon}`;
                }
                
                appendTextToNode(el, info);
            });
        }
        // Логика KZ -> RU
        else if (isKZ) {
            getRegionalPrice(appId, 'ru', (ruPriceInRub) => {
                if (!el.isConnected) return;
                
                let myTengeInRub = Math.round(currentPriceVal * kztToRub);
                let info = `(≈${myTengeInRub}₽)`;

                if (ruPriceInRub) {
                    let diff = 0;
                    if (myTengeInRub > ruPriceInRub) {
                        diff = Math.round(((myTengeInRub - ruPriceInRub) / myTengeInRub) * 100);
                        info += ` | RU: ${ruPriceInRub}₽ (-${diff}%) 📉`; // В РФ дешевле
                    } else {
                        diff = Math.round(((ruPriceInRub - myTengeInRub) / myTengeInRub) * 100);
                        info += ` | RU: ${ruPriceInRub}₽ (+${diff}%) 📈`; // В РФ дороже
                    }
                }
                
                appendTextToNode(el, info);
            });
        }
    }

    // --- 5. Поиск ID ---
    function getAppId(el) {
        let m = location.href.match(/app\/(\d+)/);
        if (m) return m[1];
        
        const form = el.closest('form');
        if (form) {
            const action = form.getAttribute('action');
            if (action && action.includes('add_to_cart')) {
                const parent = el.closest('[data-ds-appid]');
                if (parent) return parent.getAttribute('data-ds-appid');
            }
        }
        return null;
    }

    // --- 6. Сканирование ---
    function runScan() {
        const selectors = [
            ".game_purchase_price", 
            ".discount_final_price",
            ".price"
        ];
        document.querySelectorAll(selectors.join(", ")).forEach(processPriceElement);
    }

    function startObserver() {
        const observer = new MutationObserver(() => {
            if (scanTimeout) clearTimeout(scanTimeout);
            scanTimeout = setTimeout(runScan, 1000);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    init();
})();
