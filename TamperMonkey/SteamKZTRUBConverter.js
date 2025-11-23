// ==UserScript==
// @name         Steam RU/KZ Price Comparator (Compatibility Mode v5.0)
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Работает вместе с другими расширениями (SIH, Augmented Steam). Вставляет цены РЯДОМ, а не внутрь.
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
                    
                    // Задержка первого запуска, чтобы дать прогрузиться другим расширениям (SIH и т.д.)
                    setTimeout(() => {
                        runScan();
                        startObserver();
                    }, 1500); 
                } catch(e) { console.error("[SteamPrice] Ошибка курса:", e); }
            }
        });
    }

    // --- 2. API Запрос ---
    function getRegionalPrice(appId, regionCC, callback) {
        const cacheKey = `${appId}_${regionCC}`;
        if (priceCache[cacheKey] !== undefined) return callback(priceCache[cacheKey]);

        // Небольшая очередь запросов
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
                            priceCache[cacheKey] = null; // Нет цены (бесплатно или недоступно)
                            callback(null);
                        }
                    } catch (e) {
                        priceCache[cacheKey] = null;
                        callback(null);
                    }
                }
            });
        }, 100);
    }

    // --- 3. Логика ---
    function processPriceElement(el) {
        // Проверяем, не обработали ли мы уже этот блок (или его соседа)
        if (el.dataset.spProcessed === "1") return;
        
        // ВНИМАНИЕ: Если рядом уже есть наш блок (вставленный previously), не дублируем
        if (el.nextElementSibling && el.nextElementSibling.classList.contains('steam-price-comp-v5')) {
             el.dataset.spProcessed = "1";
             return;
        }

        const rawText = el.innerText || "";
        const text = rawText.toLowerCase();

        // Определение валюты
        const isKZ = text.includes("₸");
        const isRU = text.includes("руб") || text.includes("rub") || text.includes("₽") || text.includes("р.");

        if (!isKZ && !isRU) return;

        // Чистим цену от мусора других расширений
        const digits = rawText.replace(/\D/g, "");
        if (!digits) return;
        const currentPriceVal = parseInt(digits, 10);
        
        const appId = getAppId(el);
        if (!appId) return;

        el.dataset.spProcessed = "1";

        // Логика RU -> KZ
        if (isRU) {
            getRegionalPrice(appId, 'kz', (kzPriceInTenge) => {
                if (!el.isConnected || !kzPriceInTenge) return;

                let kzPriceInRub = Math.round(kzPriceInTenge * kztToRub);
                let diff = 0;
                let color = "#9ae2a8"; // Green
                let text = "";

                if (currentPriceVal > kzPriceInRub) {
                     diff = Math.round(((currentPriceVal - kzPriceInRub) / currentPriceVal) * 100);
                     text = `🇰🇿 ${kzPriceInRub}₽ (-${diff}%)`;
                } else {
                     diff = Math.round(((kzPriceInRub - currentPriceVal) / currentPriceVal) * 100);
                     color = "#e29a9a"; // Red
                     text = `🇰🇿 ${kzPriceInRub}₽ (+${diff}%)`;
                }
                insertInfoAfter(el, text, color);
            });
        }
        // Логика KZ -> RU
        else if (isKZ) {
            getRegionalPrice(appId, 'ru', (ruPriceInRub) => {
                if (!el.isConnected) return;
                let myTengeInRub = Math.round(currentPriceVal * kztToRub);
                let text = `≈${myTengeInRub}₽`;
                let color = "#9ae2a8";

                if (ruPriceInRub) {
                    let diff = 0;
                    if (myTengeInRub > ruPriceInRub) {
                        diff = Math.round(((myTengeInRub - ruPriceInRub) / myTengeInRub) * 100);
                        text += ` | 🇷🇺 ${ruPriceInRub}₽ (-${diff}%)`;
                        color = "#e29a9a";
                    } else {
                        diff = Math.round(((ruPriceInRub - myTengeInRub) / myTengeInRub) * 100);
                        text += ` | 🇷🇺 ${ruPriceInRub}₽ (+${diff}%)`;
                    }
                }
                insertInfoAfter(el, text, color);
            });
        }
    }

    // --- 4. Вставка (БЕЗОПАСНАЯ) ---
    function insertInfoAfter(targetEl, text, color) {
        // Создаем отдельный блок
        const div = document.createElement("div");
        div.className = "steam-price-comp-v5";
        div.textContent = text;
        div.style.cssText = `
            display: block;
            color: ${color};
            font-size: 11px;
            font-weight: bold;
            font-family: Arial, sans-serif;
            margin-top: 2px;
            margin-bottom: 5px;
            line-height: 1.2;
            padding-left: 2px;
        `;

        // Вместо appendChild (внутрь), делаем insertAdjacentElement (после)
        // Это не ломает структуру внутри кнопки, которую читает другое расширение
        targetEl.insertAdjacentElement('afterend', div);
    }

    // --- 5. Поиск ID ---
    function getAppId(el) {
        let m = location.href.match(/app\/(\d+)/);
        if (m) return m[1];
        
        // Попытка найти в форме, если мы в списке
        const form = el.closest('form');
        if (form) {
            const action = form.getAttribute('action');
            if (action && action.includes('add_to_cart')) {
                // В списках часто нет appid в чистом виде, API требует appid
                // Попробуем найти data-ds-appid у родителя
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
            // Увеличенный debounce (800мс), чтобы другие скрипты успели отработать
            scanTimeout = setTimeout(runScan, 800);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    init();
})();
