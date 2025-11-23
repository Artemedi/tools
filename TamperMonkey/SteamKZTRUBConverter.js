// ==UserScript==
// @name         Steam RU/KZ Price Comparator & Converter (Fixed v3.2)
// @namespace    http://tampermonkey.net/
// @version      3.2
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

    /** Запрос цены в другом регионе через Steam API
     *  anonymous: true - ОБЯЗАТЕЛЬНО, чтобы Steam не подтягивал куки твоего региона
     */
    function getRegionalPrice(appId, regionCC, callback) {
        const cacheKey = `${appId}_${regionCC}`;
        if (priceCache[cacheKey] !== undefined) {
            return callback(priceCache[cacheKey]);
        }

        log(`Запрос цены для AppID ${appId} в регионе ${regionCC}...`);

        GM_xmlhttpRequest({
            method: "GET",
            url: `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${regionCC}&filters=price_overview`,
            anonymous: true, // <--- КРИТИЧЕСКИ ВАЖНО ДЛЯ РАБОТЫ В RU РЕГИОНЕ
            onload: res => {
                try {
                    const json = JSON.parse(res.responseText);
                    if (json[appId] && json[appId].success && json[appId].data.price_overview) {
                        const price = json[appId].data.price_overview.final / 100;
                        log(`Получена цена для ${appId} [${regionCC}]: ${price}`);
                        priceCache[cacheKey] = price;
                        callback(price);
                    } else {
                        log(`Цена недоступна для ${appId} в [${regionCC}] (возможно, блок региона или f2p)`);
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
        if (el.dataset.enhanced === "1" || !kztToRub) return;

        const rawText = el.innerText;
        // Нормализуем текст для поиска (нижний регистр, замена похожих символов)
        const text = rawText.toLowerCase().replace(/\s/g, ''); 

        // Определение валюты (более жесткое)
        // \u20BD - знак рубля.
        // pуб - латинская p + кириллица
        // руб - кириллица
        const isKZ = text.includes("₸");
        const isRU = text.includes("руб") || text.includes("rub") || text.includes("₽") || text.includes("р.");

        if (!isKZ && !isRU) return; 

        // Парсинг текущей цены со страницы
        let currentPriceVal = parseFloat(rawText.replace(/[^\d,.]/g, "").replace(",", "."));
        // Фикс для цен типа "1 200" -> parse может вернуть 1. Удаляем пробелы перед парсингом.
        if (rawText.match(/\d\s\d/)) {
             currentPriceVal = parseInt(rawText.replace(/\D/g, ""));
        }

        if (!currentPriceVal || isNaN(currentPriceVal)) return;

        // Получаем AppID
        let appId = getAppId();
        
        // Если не нашли в URL, пробуем найти в кнопке покупки (для списков)
        if (!appId) {
            const btn = el.closest('form') || el.closest('.game_area_purchase_game');
            if (btn) {
                const input = btn.querySelector('input[name="subid"], input[name="bundleid"]');
                // Для бандлов логика сложнее, пока пропускаем, ищем игру
                // Можно попытаться найти data-ds-appid в родителях
            }
            // Если всё еще нет ID, пропускаем (чтобы не спамить ошибками)
            return;
        }

        el.dataset.enhanced = "1"; 

        // === СЦЕНАРИЙ 1: МЫ В РОССИИ (РУБЛИ) -> СМОТРИМ КАЗАХСТАН ===
        if (isRU) {
            // 1. Запрашиваем цену в KZ (она придет в Тенге)
            getRegionalPrice(appId, 'kz', (kzPriceInTenge) => {
                if (!kzPriceInTenge) return;

                // 2. Конвертируем Тенге -> Рубли по курсу
                let kzPriceInRub = Math.round(kzPriceInTenge * kztToRub);
                
                // 3. Считаем разницу
                let diff = 0;
                let color = "#9ae2a8"; // Зеленый (выгодно)
                let diffText = "";

                if (currentPriceVal > kzPriceInRub) {
                     // В KZ дешевле (RU: 1000, KZ_conv: 500)
                     diff = Math.round(((currentPriceVal - kzPriceInRub) / currentPriceVal) * 100);
                     diffText = `-${diff}%`;
                } else {
                     // В KZ дороже (RU: 1000, KZ_conv: 1500)
                     diff = Math.round(((kzPriceInRub - currentPriceVal) / currentPriceVal) * 100);
                     color = "#e29a9a"; // Красный (невыгодно)
                     diffText = `+${diff}%`;
                }
                
                appendInfo(el, `🇰🇿 KZ: ${kzPriceInRub}₽ (${diffText})`, color);
            });
        }

        // === СЦЕНАРИЙ 2: МЫ В КАЗАХСТАНЕ (ТЕНГЕ) -> СМОТРИМ РОССИЮ ===
        else if (isKZ) {
            // 1. Запрашиваем цену в RU (она придет в Рублях)
            getRegionalPrice(appId, 'ru', (ruPriceInRub) => {
                
                // Для справки показываем, сколько наши тенге стоят в рублях сейчас
                let myTengeInRub = Math.round(currentPriceVal * kztToRub);
                let infoText = `≈ ${myTengeInRub}₽`; 
                let color = "#9ae2a8";

                if (ruPriceInRub) {
                    // Сравниваем наши сконвертированные рубли с реальной ценой РФ
                    let diff = 0;
                    if (myTengeInRub > ruPriceInRub) {
                         // В РФ дешевле (мы переплачиваем)
                         diff = Math.round(((myTengeInRub - ruPriceInRub) / myTengeInRub) * 100);
                         infoText += ` | 🇷🇺 RU: ${ruPriceInRub}₽ (там дешевле на ${diff}%)`;
                         color = "#e29a9a"; 
                    } else {
                         // В РФ дороже (мы платим меньше)
                         diff = Math.round(((ruPriceInRub - myTengeInRub) / myTengeInRub) * 100);
                         infoText += ` | 🇷🇺 RU: ${ruPriceInRub}₽ (там дороже на ${diff}%)`;
                    }
                } else {
                    infoText += " | 🇷🇺 RU: недоступно";
                }

                appendInfo(el, infoText, color);
            });
        }
    }

    function appendInfo(el, text, color) {
        if (el.querySelector('.steam-price-comp')) return;
        const div = document.createElement("div");
        div.className = "steam-price-comp";
        div.style.cssText = `color: ${color}; font-size: 11px; line-height: 12px; margin-top: 2px;`;
        div.textContent = text;
        el.appendChild(div);
    }

    function getAppId() {
        // Ищем в URL
        let m = location.href.match(/app\/(\d+)/);
        if (m) return m[1];
        
        // Если мы на странице Wishlist или поиска, пробуем найти через hover-атрибуты (опционально)
        return null;
    }

    function runScan() {
        // Селекторы цен
        const selectors = [
            ".game_purchase_price", 
            ".discount_final_price",
            // Обработка блоков в поиске или списках (если нужно, можно раскомментировать)
            // ".col.search_price_discount_combined .responsive_secondrow" 
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
        observer.observe(document.body, { childList: true, subtree: true });
    }

    init();
})();
