// ==UserScript==
// @name         Steam RU/KZ Price Comparator & Converter (Fixed v3.3)
// @namespace    http://tampermonkey.net/
// @version      3.3
// @description  RU регион: запрашивает цену KZ, конвертирует в RUB и сравнивает. KZ регион: запрашивает цену RU в рублях.
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

    function log(msg) {
        console.log(`[SteamPrice]: ${msg}`);
    }

    // Инициализация: загрузка курса
    function init() {
        GM_xmlhttpRequest({
            method: "GET",
            url: RATE_API,
            onload: res => {
                try {
                    const data = JSON.parse(res.responseText);
                    kztToRub = data.rates.RUB;
                    log(`Курс загружен: 100 KZT = ${(kztToRub * 100).toFixed(2)} RUB`);
                    runScan();
                    startObserver();
                } catch(e) { console.error("[SteamPrice] Ошибка парсинга курса:", e); }
            },
            onerror: err => console.error("[SteamPrice] Ошибка загрузки курса:", err)
        });
    }

    /** Запрос цены в другом регионе (anonymous: true нужен для обхода кук) */
    function getRegionalPrice(appId, regionCC, callback) {
        const cacheKey = `${appId}_${regionCC}`;
        if (priceCache[cacheKey] !== undefined) {
            return callback(priceCache[cacheKey]);
        }

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
                    console.error(`[SteamPrice] Ошибка API Steam [${regionCC}]:`, e);
                    callback(null);
                }
            }
        });
    }

    function processPriceElement(el) {
        // Защита от повторной обработки
        if (el.dataset.enhanced === "1" || !kztToRub) return;

        const rawText = el.innerText || "";
        const text = rawText.toLowerCase();

        // Простая проверка валюты
        const isKZ = text.includes("₸");
        const isRU = text.includes("руб") || text.includes("rub") || text.includes("₽") || text.includes("р.");

        if (!isKZ && !isRU) return;

        // ПАРСИНГ ЦЕНЫ: Оставляем только цифры.
        // Это самый надежный способ для Steam (там нет копеек в основном виде)
        const digitsOnly = rawText.replace(/\D/g, "");
        if (!digitsOnly) return;
        
        let currentPriceVal = parseInt(digitsOnly, 10);
        if (!currentPriceVal) return;

        const appId = getAppId(el);
        if (!appId) return;

        // Помечаем, что начали обработку
        el.dataset.enhanced = "1";

        // === RU REGION ===
        if (isRU) {
            getRegionalPrice(appId, 'kz', (kzPriceInTenge) => {
                // Если элемент исчез из DOM пока шел запрос (бывает при SPA переходах)
                if (!el.isConnected) return;

                if (!kzPriceInTenge) {
                    log(`Цена KZ не найдена для ${appId}`);
                    return;
                }

                // Логика расчета
                let kzPriceInRub = Math.round(kzPriceInTenge * kztToRub);
                let diff = 0;
                let color = "#9ae2a8"; // Зеленый
                let sign = "";

                if (currentPriceVal > kzPriceInRub) {
                     // В KZ дешевле
                     diff = Math.round(((currentPriceVal - kzPriceInRub) / currentPriceVal) * 100);
                     sign = "-";
                } else {
                     // В KZ дороже
                     diff = Math.round(((kzPriceInRub - currentPriceVal) / currentPriceVal) * 100);
                     color = "#e29a9a"; // Красный
                     sign = "+";
                }

                const infoText = `🇰🇿 ${kzPriceInRub}₽ (${sign}${diff}%)`;
                log(`[RU Logic] Текущая: ${currentPriceVal}, KZ(conv): ${kzPriceInRub}. Diff: ${diff}%`);
                
                appendInfo(el, infoText, color);
            });
        }

        // === KZ REGION ===
        else if (isKZ) {
            getRegionalPrice(appId, 'ru', (ruPriceInRub) => {
                if (!el.isConnected) return;

                let myTengeInRub = Math.round(currentPriceVal * kztToRub);
                let infoText = `≈ ${myTengeInRub}₽`;
                let color = "#9ae2a8";

                if (ruPriceInRub) {
                    let diff = 0;
                    if (myTengeInRub > ruPriceInRub) {
                         // В РФ дешевле
                         diff = Math.round(((myTengeInRub - ruPriceInRub) / myTengeInRub) * 100);
                         infoText += ` | 🇷🇺 ${ruPriceInRub}₽ (-${diff}%)`;
                         color = "#e29a9a"; 
                    } else {
                         // В РФ дороже
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

    function appendInfo(el, text, color) {
        // Проверка на дубли
        if (el.querySelector('.steam-price-comp')) return;

        // Создаем контейнер
        const span = document.createElement("span");
        span.className = "steam-price-comp";
        
        // Стилизация: display: block заставит перенестись на новую строку
        // line-height нормализует высоту строки
        span.style.cssText = `
            display: block; 
            color: ${color}; 
            font-size: 11px; 
            line-height: 1.2; 
            margin-top: 2px; 
            font-weight: bold;
            font-family: Arial, sans-serif;
        `;
        span.textContent = text;
        
        // Вставляем В КОНЕЦ элемента цены.
        el.appendChild(span);
        
        // Если родитель имеет display: flex и align-items: center, текст может уехать.
        // Добавляем принудительный перенос строки перед нашим спаном, если это не блочный элемент
        if (window.getComputedStyle(el).display !== 'block') {
             // span.style.display = "inline-block"; // или оставьте block
             // Можно добавить <br> если совсем всё плохо с версткой
        }
    }

    function getAppId(el) {
        // 1. Из URL
        let m = location.href.match(/app\/(\d+)/);
        if (m) return m[1];
        
        // 2. Попытка найти ID в кнопке (для списков желаемого и бандлов)
        // Ищем ближайший input с name="subid" или форму добавления
        const form = el.closest('form');
        if (form) {
             const action = form.getAttribute('action');
             if (action) {
                 // add_to_cart/12345
                 let actM = action.match(/add_to_cart\/(\d+)/);
                 if (actM) return actM[1]; // Это SubID, но для цен often works, хотя лучше AppID
             }
        }
        return null;
    }

    function runScan() {
        const selectors = [
            ".game_purchase_price", 
            ".discount_final_price",
            ".price" // Универсальный селектор
        ];
        document.querySelectorAll(selectors.join(", ")).forEach(processPriceElement);
    }

    function startObserver() {
        const observer = new MutationObserver((mutations) => {
            let shouldScan = false;
            for (let m of mutations) {
                if (m.addedNodes.length) { shouldScan = true; break; }
            }
            if (shouldScan) runScan();
        });
        
        // Следим за всем body, так как цены могут быть где угодно
        observer.observe(document.body, { childList: true, subtree: true });
    }

    init();
})();
