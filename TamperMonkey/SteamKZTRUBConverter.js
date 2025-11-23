// ==UserScript==
// @name         Steam RU/KZ Price Comparator & Converter
// @namespace    http://tampermonkey.net/
// @version      3.0
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

    // Используем надежный бесплатный API
    const RATE_API = "https://api.exchangerate-api.com/v4/latest/KZT";
    let kztToRub = 0;
    let rubToKzt = 0; // На случай обратной конвертации

    // Кэш цен, чтобы не спамить запросами к Steam API для одной и той же игры
    const priceCache = {};

    function init() {
        GM_xmlhttpRequest({
            method: "GET",
            url: RATE_API,
            onload: res => {
                try {
                    const data = JSON.parse(res.responseText);
                    kztToRub = data.rates.RUB;
                    rubToKzt = 1 / kztToRub;
                    console.log(`[Steam script] Курс загружен: 100 KZT ≈ ${(kztToRub * 100).toFixed(2)} RUB`);
                    
                    // Запускаем сканирование сразу после получения курса
                    runScan();
                    // И запускаем обсервер для динамического контента
                    startObserver();
                } catch(e) { console.error("[Steam script] Ошибка курса:", e); }
            }
        });
    }

    /** Запрос цены в другом регионе через Steam API */
    function getRegionalPrice(appId, regionCC, callback) {
        const cacheKey = `${appId}_${regionCC}`;
        if (priceCache[cacheKey]) {
            return callback(priceCache[cacheKey]);
        }

        GM_xmlhttpRequest({
            method: "GET",
            url: `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${regionCC}&filters=price_overview`,
            onload: res => {
                try {
                    let json = JSON.parse(res.responseText);
                    // Проверка успешности
                    if (!json[appId] || !json[appId].success || !json[appId].data.price_overview) {
                        callback(null);
                        return;
                    }
                    // Цена приходит в копейках/тиынах, делим на 100
                    let price = json[appId].data.price_overview.final / 100;
                    
                    priceCache[cacheKey] = price;
                    callback(price);
                } catch (e) {
                    console.error("Steam API error:", e);
                    callback(null);
                }
            }
        });
    }

    function processPriceElement(el) {
        // Если уже обработали или курс не загружен — выходим
        if (el.dataset.enhanced === "1" || !kztToRub) return;
        
        const text = el.innerText; // innerText лучше, чем textContent, игнорирует скрытые стили
        
        // Парсим текущую цену со страницы (удаляем все кроме цифр)
        // Steam обычно не пишет копейки для игр, но на всякий случай
        let currentPriceVal = parseInt(text.replace(/\D/g, ""));
        if (isNaN(currentPriceVal)) return;

        // Определяем валюту на странице
        const isKZ = text.includes("₸");
        const isRU = text.includes(" p") || text.includes("₽") || text.includes("rub");

        // Получаем AppID (только для страниц игр/dlc, игнорируем бандлы пока что)
        const appId = getAppId();
        if (!appId) return;

        // Помечаем, что начали обработку (чтобы не дублировать запросы), но закончим позже
        el.dataset.enhanced = "1"; 

        // Сценарий 1: Мы в РОССИИ (Рубли) -> Проверяем Казахстан
        if (isRU) {
            getRegionalPrice(appId, 'kz', (kzPriceInTenge) => {
                if (!kzPriceInTenge) return;

                // Конвертируем Тенге (из API) в Рубли (по курсу)
                let kzPriceInRub = Math.round(kzPriceInTenge * kztToRub);
                
                // Считаем разницу
                // Если KZ (500р) дешевле чем RU (1000р) -> (1000-500)/1000 = 50% выгоды
                let diff = 0;
                let color = "#9ae2a8"; // Зеленый
                let sign = "";

                if (currentPriceVal > 0) {
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
                }

                appendInfo(el, ` | KZ: ${kzPriceInRub}₽ (${sign}${diff}%)`, color);
            });
        }

        // Сценарий 2: Мы в КАЗАХСТАНЕ (Тенге) -> Проверяем Россию
        else if (isKZ) {
            // Сначала просто покажем примерную цену в рублях рядом (конвертация текущей цены)
            let approxRub = Math.round(currentPriceVal * kztToRub);
            
            // Теперь запросим реальную цену в РФ через API (чтобы сравнить, вдруг в РФ дешевле/дороже)
            getRegionalPrice(appId, 'ru', (ruPriceInRub) => {
                let finalText = ` ≈ ${approxRub}₽`; // Базовая конвертация
                let color = "#9ae2a8";

                if (ruPriceInRub) {
                    // Если удалось получить цену РФ, сравниваем точнее
                    let diff = 0;
                    let sign = "";
                    
                    // Сравниваем цену в тенге (текущую) с ценой РФ (переведенной в тенге для сравнения или наоборот)
                    // Давайте сравнивать всё в рублях для наглядности
                    
                    if (approxRub > ruPriceInRub) {
                         // В РФ дешевле (мы переплачиваем в KZ)
                         diff = Math.round(((approxRub - ruPriceInRub) / approxRub) * 100);
                         finalText += ` | RU: ${ruPriceInRub}₽ (Дешевле на ${diff}%)`;
                         color = "#e29a9a"; // Красный (так как мы в KZ переплачиваем)
                    } else {
                         // В РФ дороже (мы в плюсе)
                         diff = Math.round(((ruPriceInRub - approxRub) / approxRub) * 100);
                         finalText += ` | RU: ${ruPriceInRub}₽ (Там дороже на ${diff}%)`;
                    }
                } else {
                    finalText += " (RU цена недоступна)";
                }

                appendInfo(el, finalText, color);
            });
        }
    }

    function appendInfo(el, text, color) {
        // Проверка на дубликаты внутри элемента, если вдруг сработает дважды
        if (el.querySelector('.steam-price-helper')) return;

        const span = document.createElement("div"); // div чтобы перенести на новую строку или span
        span.className = "steam-price-helper";
        span.style.color = color || "#9ae2a8";
        span.style.fontSize = "11px";
        span.style.marginTop = "2px";
        span.style.fontWeight = "bold";
        span.textContent = text;
        
        // Добавляем после цены
        el.appendChild(span);
    }

    function getAppId() {
        // Пытаемся найти AppID в URL
        let m = location.href.match(/app\/(\d+)/);
        if (m) return m[1];
        
        // Если это список желаемого или поиск, тут сложнее, пока оставим логику для страницы игры
        return null;
    }

    function runScan() {
        const selectors = [
            ".game_purchase_price", 
            ".discount_final_price", 
            ".price" // для некоторых виджетов
        ];
        document.querySelectorAll(selectors.join(", ")).forEach(processPriceElement);
    }

    function startObserver() {
        const observer = new MutationObserver(() => {
            runScan();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Запуск
    init();

})();
