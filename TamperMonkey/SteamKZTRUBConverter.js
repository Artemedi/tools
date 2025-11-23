// ==UserScript==
// @name         Steam RU/KZ Price Comparator & Converter (Fix)
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  RU регион: показывает цену KZ в рублях + % разницы. KZ регион: показывает цену RU.
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
                } catch(e) { console.error("[SteamPrice] Ошибка курса:", e); }
            },
            onerror: err => console.error("[SteamPrice] Ошибка сети (курсы):", err)
        });
    }

    function getRegionalPrice(appId, regionCC, callback) {
        const cacheKey = `${appId}_${regionCC}`;
        if (priceCache[cacheKey]) return callback(priceCache[cacheKey]);

        // Важно: запрос к API должен идти без кук, либо с правильными параметрами
        // GM_xmlhttpRequest отправляет куки по умолчанию.
        // Steam API (appdetails) обычно уважает параметр ?cc=, даже если куки есть.
        GM_xmlhttpRequest({
            method: "GET",
            url: `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${regionCC}&filters=price_overview`,
            onload: res => {
                try {
                    const json = JSON.parse(res.responseText);
                    if (json[appId] && json[appId].success && json[appId].data.price_overview) {
                        const price = json[appId].data.price_overview.final / 100;
                        priceCache[cacheKey] = price;
                        callback(price);
                    } else {
                        // Часто бывает для бесплатных игр или паков
                        log(`Не удалось получить цену для AppID ${appId} в регионе ${regionCC}`);
                        callback(null);
                    }
                } catch (e) {
                    console.error("Steam API parse error:", e);
                    callback(null);
                }
            }
        });
    }

    function processPriceElement(el) {
        if (el.dataset.enhanced === "1" || !kztToRub) return;

        const text = el.innerText.toLowerCase().trim();
        
        // Более надежное определение валюты через RegExp
        // \u20BD - это символ рубля (₽)
        // \u0440 - это кириллическая 'р'
        // p - это латинская 'p'
        const isKZ = text.includes("₸");
        const isRU = /руб|rub|\u20BD|\d\s?р\./i.test(text); 

        if (!isKZ && !isRU) return; // Не поняли валюту, пропускаем

        const appId = getAppId();
        if (!appId) return;

        let currentPriceVal = parseFloat(text.replace(/[^\d,.]/g, "").replace(",", "."));
        // Иногда парсинг захватывает лишнее, если цена вида "1 200", убираем пробелы перед парсингом
        if (isNaN(currentPriceVal)) {
             currentPriceVal = parseInt(text.replace(/\D/g, ""));
        }
        
        if (!currentPriceVal) return;

        el.dataset.enhanced = "1"; // Помечаем как обработанный

        // === Логика для RU региона (показываем KZ) ===
        if (isRU) {
            getRegionalPrice(appId, 'kz', (kzPriceInTenge) => {
                if (!kzPriceInTenge) return;

                let kzPriceInRub = Math.round(kzPriceInTenge * kztToRub);
                let diff = 0;
                let color = "#9ae2a8"; // Зеленый (хорошо)
                let arrow = "📉"; // Дешевле

                if (currentPriceVal > kzPriceInRub) {
                     // В KZ дешевле
                     diff = Math.round(((currentPriceVal - kzPriceInRub) / currentPriceVal) * 100);
                } else {
                     // В KZ дороже
                     diff = Math.round(((kzPriceInRub - currentPriceVal) / currentPriceVal) * 100);
                     color = "#e29a9a"; // Красный
                     arrow = "📈"; // Дороже
                }

                // Если разница мизерная (менее 1%), не спамим, или пишем 0
                const diffText = (currentPriceVal > kzPriceInRub) ? `-${diff}%` : `+${diff}%`;
                
                appendInfo(el, `🇰🇿 KZ: ${kzPriceInRub}₽ (${diffText})`, color);
            });
        }

        // === Логика для KZ региона (показываем RU) ===
        else if (isKZ) {
            // Примерная конвертация того, что видим
            let approxRub = Math.round(currentPriceVal * kztToRub);
            
            getRegionalPrice(appId, 'ru', (ruPriceInRub) => {
                let infoText = `≈ ${approxRub}₽`;
                let color = "#9ae2a8";

                if (ruPriceInRub) {
                    let diff = 0;
                    if (approxRub > ruPriceInRub) {
                        // В РФ дешевле (мы переплачиваем в тенге)
                        diff = Math.round(((approxRub - ruPriceInRub) / approxRub) * 100);
                        infoText += ` | 🇷🇺 RU: ${ruPriceInRub}₽ (-${diff}% дешевле)`;
                        color = "#e29a9a"; // Красный, так как текущая цена (KZ) хуже
                    } else {
                        // В РФ дороже (мы в плюсе)
                        diff = Math.round(((ruPriceInRub - approxRub) / approxRub) * 100);
                        infoText += ` | 🇷🇺 RU: ${ruPriceInRub}₽ (+${diff}% дороже)`;
                    }
                } else {
                    infoText += " | RU: недоступно";
                }
                appendInfo(el, infoText, color);
            });
        }
    }

    function appendInfo(el, text, color) {
        // Защита от дублей (на случай ре-рендера React компонентов стима)
        if (el.querySelector('.steam-price-comp')) return;

        const div = document.createElement("div");
        div.className = "steam-price-comp";
        div.style.color = color;
        div.style.fontSize = "11px";
        div.style.lineHeight = "12px";
        div.style.marginTop = "2px";
        div.style.fontWeight = "normal";
        div.style.fontFamily = "Arial, sans-serif";
        div.textContent = text;
        el.appendChild(div);
    }

    function getAppId() {
        // 1. Пробуем вытащить из URL
        let m = location.href.match(/app\/(\d+)/);
        if (m) return m[1];

        // 2. Если мы в списке, иногда можно найти data-ds-appid у родителя
        // Но пока оставим только URL, чтобы не ломать логику на сложных страницах
        return null;
    }

    function runScan() {
        const selectors = [
            ".game_purchase_price", 
            ".discount_final_price", 
            ".price"
        ];
        document.querySelectorAll(selectors.join(", ")).forEach(processPriceElement);
    }

    function startObserver() {
        const observer = new MutationObserver((mutations) => {
            // Не запускаем сканирование на каждое мелкое изменение, проверяем добавились ли ноды
            let shouldScan = false;
            for (let m of mutations) {
                if (m.addedNodes.length) { shouldScan = true; break; }
            }
            if (shouldScan) runScan();
        });
        observer.observe(document.querySelector('.page_content_ctn') || document.body, { childList: true, subtree: true });
    }

    init();
})();
