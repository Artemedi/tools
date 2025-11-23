// ==UserScript==
// @name         Steam RU/KZ Price Comparator & Converter (v4.0 Stable)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  RU регион: показывает цену KZ. KZ регион: показывает цену RU. Оптимизировано для Chrome.
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
    let scanTimeout = null; // Для Debounce

    function log(msg) {
        // Раскомментируй для отладки, по умолчанию выключено, чтобы не засорять консоль
        // console.log(`[SteamPrice]: ${msg}`);
    }

    // --- 1. Загрузка курса ---
    function init() {
        GM_xmlhttpRequest({
            method: "GET",
            url: RATE_API,
            onload: res => {
                try {
                    const data = JSON.parse(res.responseText);
                    kztToRub = data.rates.RUB;
                    console.log(`[SteamPrice] Курс загружен: 100 KZT = ${(kztToRub * 100).toFixed(2)} RUB`);
                    runScan(); // Первый прогон
                    startObserver(); // Запуск слежения
                } catch(e) { console.error("[SteamPrice] Ошибка курса:", e); }
            }
        });
    }

    // --- 2. API Запросы (Кэшированные) ---
    function getRegionalPrice(appId, regionCC, callback) {
        const cacheKey = `${appId}_${regionCC}`;
        if (priceCache[cacheKey] !== undefined) return callback(priceCache[cacheKey]);

        // Используем очередь или просто таймаут, чтобы не душить API, если запросов много
        setTimeout(() => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${regionCC}&filters=price_overview`,
                anonymous: true, // Скрываем куки (важно для RU региона)
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
                        // Ошибки парсинга глушим, чтобы не спамить в консоль
                        priceCache[cacheKey] = null;
                        callback(null);
                    }
                },
                onerror: () => callback(null)
            });
        }, 50); // Небольшая задержка запроса
    }

    // --- 3. Обработка ценника ---
    function processPriceElement(el) {
        if (el.dataset.steamPriceEnhanced === "1" || !kztToRub) return;

        // Получаем чистый текст
        const rawText = el.innerText || "";
        const text = rawText.toLowerCase();

        // Проверка валюты
        const isKZ = text.includes("₸");
        const isRU = text.includes("руб") || text.includes("rub") || text.includes("₽") || text.includes("р.");

        if (!isKZ && !isRU) return;

        // Извлекаем цифры (защита от "1 200")
        const digits = rawText.replace(/\D/g, "");
        if (!digits) return;
        const currentPriceVal = parseInt(digits, 10);
        
        // Получаем AppID
        const appId = getAppId(el);
        if (!appId) return;

        // Помечаем элемент
        el.dataset.steamPriceEnhanced = "1";

        // ЛОГИКА RU
        if (isRU) {
            getRegionalPrice(appId, 'kz', (kzPriceInTenge) => {
                if (!el.isConnected || !kzPriceInTenge) return;

                let kzPriceInRub = Math.round(kzPriceInTenge * kztToRub);
                let diff = Math.round(((currentPriceVal - kzPriceInRub) / currentPriceVal) * 100);
                
                // Если KZ дешевле -> разница положительная (выгода), цвет зеленый
                // Если KZ дороже -> разница отрицательная, цвет красный
                let color = "#9ae2a8"; // Green
                let diffStr = "";

                if (currentPriceVal > kzPriceInRub) {
                     // В КЗ дешевле
                     diff = Math.round(((currentPriceVal - kzPriceInRub) / currentPriceVal) * 100);
                     diffStr = `-${diff}%`;
                } else {
                     // В КЗ дороже
                     diff = Math.round(((kzPriceInRub - currentPriceVal) / currentPriceVal) * 100);
                     color = "#e29a9a"; // Red
                     diffStr = `+${diff}%`;
                }

                appendInfo(el, `🇰🇿 ${kzPriceInRub}₽ (${diffStr})`, color);
            });
        }
        // ЛОГИКА KZ
        else if (isKZ) {
            getRegionalPrice(appId, 'ru', (ruPriceInRub) => {
                if (!el.isConnected) return;

                let myTengeInRub = Math.round(currentPriceVal * kztToRub);
                let infoText = `≈${myTengeInRub}₽`;
                let color = "#9ae2a8"; 

                if (ruPriceInRub) {
                    let diff = 0;
                    if (myTengeInRub > ruPriceInRub) {
                        diff = Math.round(((myTengeInRub - ruPriceInRub) / myTengeInRub) * 100);
                        infoText += ` | 🇷🇺 ${ruPriceInRub}₽ (-${diff}%)`;
                        color = "#e29a9a"; // Красный, т.к. мы переплачиваем
                    } else {
                        diff = Math.round(((ruPriceInRub - myTengeInRub) / myTengeInRub) * 100);
                        infoText += ` | 🇷🇺 ${ruPriceInRub}₽ (+${diff}%)`;
                    }
                } else {
                    infoText += " | 🇷🇺 n/a";
                }
                appendInfo(el, infoText, color);
            });
        }
    }

    // --- 4. Отрисовка ---
    function appendInfo(el, text, color) {
        if (el.querySelector('.steam-price-comp-v4')) return;

        const container = document.createElement("div");
        container.className = "steam-price-comp-v4";
        // Используем !important чтобы перебить стили стима
        container.style.cssText = `
            display: block !important;
            color: ${color} !important;
            font-size: 11px !important;
            line-height: 1.2 !important;
            margin-top: 3px !important;
            font-family: Arial, sans-serif !important;
            font-weight: bold !important;
            white-space: nowrap !important;
            opacity: 0.9;
        `;
        container.textContent = text;
        
        // Вставляем внутрь
        el.appendChild(container);
    }

    // --- 5. Поиск ID ---
    function getAppId(el) {
        // 1. Из URL страницы
        let m = location.href.match(/app\/(\d+)/);
        if (m) return m[1];
        
        // 2. Из кнопки покупки (для списков)
        const btn = el.closest('form') || el.closest('.game_area_purchase_game');
        if (btn) {
            const action = btn.getAttribute('action');
            if (action && action.includes('add_to_cart')) {
                // Пытаемся вытянуть subid, но для грубой оценки пойдет, 
                // хотя API стима требует appid. 
                // Лучше вернем null, чтобы не делать ошибочных запросов на списках
                return null; 
            }
        }
        return null; 
    }

    // --- 6. Запуск сканирования (Debounced) ---
    function runScan() {
        const selectors = [
            ".game_purchase_price", 
            ".discount_final_price",
            ".price"
        ];
        const elements = document.querySelectorAll(selectors.join(", "));
        elements.forEach(processPriceElement);
    }

    function startObserver() {
        const observer = new MutationObserver((mutations) => {
            // Если есть таймер - сбрасываем его
            if (scanTimeout) clearTimeout(scanTimeout);
            
            // Ставим новый таймер на 500мс. 
            // Это значит: "Запусти сканирование только если ничего не менялось полсекунды"
            // Это спасет Chrome от зависания и ошибок.
            scanTimeout = setTimeout(() => {
                runScan();
            }, 500);
        });
        
        observer.observe(document.body, { childList: true, subtree: true });
    }

    init();
})();
