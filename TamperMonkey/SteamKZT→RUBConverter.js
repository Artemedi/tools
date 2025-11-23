// ==UserScript==
// @name         Steam Region Price Comparator (KZ↔RU) + KZT→RUB
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Показывает конвертацию KZT->RUB и (на RU-странице) реальную цену из KZ региона, переведённую в рубли + процент разницы.
// @author       You
// @match        https://store.steampowered.com/*
// @match        https://steamcommunity.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /*******************************
     * Настройки
     *******************************/
    const DEBUG = false;

    // Частота попыток найти прайсы (ms) при загрузке динамических частей
    const PRICE_CHECK_DELAY_MS = 800;
    const MAX_RETRIES = 8;

    // API endpoints
    const APPDETAILS_API = (appid, cc) => `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=ru`;
    const PACKAGE_API = (pkgid, cc) => `https://store.steampowered.com/api/packagedetails?packageids=${pkgid}&cc=${cc}&l=ru`;
    // free exchangerate endpoint (CORS friendly)
    const EXCHANGERATE = (from, to) => `https://api.exchangerate.host/convert?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    /*******************************
     * Утилиты
     *******************************/
    function log(...args) { if (DEBUG) console.log('[SteamPriceCmp]', ...args); }

    function formatMoney(amount /* number in major units, e.g. 123.45 */, currencyCode) {
        try {
            return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: currencyCode, maximumFractionDigits: 0 }).format(amount);
        } catch (e) {
            // fallback simple
            return `${Math.round(amount)} ${currencySymbolFromCode(currencyCode) || currencyCode}`;
        }
    }

    function currencySymbolFromCode(code) {
        const map = { 'RUB': '₽', 'KZT': '₸', 'USD': '$', 'EUR': '€' };
        return map[code] || null;
    }

    // Попробовать извлечь ID приложения или package из URL
    function getIdsFromUrl(url = window.location.href) {
        // app: /app/XXXXX
        let appMatch = url.match(/\/app\/(\d+)/);
        if (appMatch) return { type: 'app', id: appMatch[1] };

        // sub: /sub/XXXXX
        let subMatch = url.match(/\/sub\/(\d+)/);
        if (subMatch) return { type: 'package', id: subMatch[1] };

        // packageid param ?packageid=XXXX
        let pkgUrl = new URL(url);
        if (pkgUrl.searchParams.get('packageid')) {
            return { type: 'package', id: pkgUrl.searchParams.get('packageid') };
        }

        return null;
    }

    // Попытка распознать валюту и числовое значение из текста ценника
    function parsePriceText(text) {
        if (!text) return null;
        // удаляем пробелы, нечисла, кроме запятой и точки и минус
        // но сначала определим валюту по символам
        let currency = null;
        if (text.includes('₸') || /KZT/i.test(text)) currency = 'KZT';
        if (text.includes('₽') || /Р|р\./i.test(text) || /RUB/i.test(text)) currency = 'RUB';
        if (text.includes('$') || /\bUSD\b/i.test(text)) currency = 'USD';
        if (text.includes('€') || /\bEUR\b/i.test(text)) currency = 'EUR';

        // find number like 1 234,56 or 1234.56 or 1234
        let numMatch = text.replace(/\u00A0/g, ' ').match(/(-?[\d\s]+[,\.]?\d*)/);
        if (!numMatch) return null;
        let raw = numMatch[1].trim().replace(/\s/g, '').replace(',', '.');
        let val = parseFloat(raw);
        if (isNaN(val)) return null;
        return { value: val, currency: currency };
    }

    // fetch JSON with error handling
    async function fetchJson(url) {
        const resp = await fetch(url, { credentials: 'omit' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
    }

    // Получить цену в локальной валюте для KZ через API steam (appdetails / packagedetails)
    async function fetchKzPriceForId(idObj) {
        try {
            if (idObj.type === 'app') {
                const url = APPDETAILS_API(idObj.id, 'kz');
                const json = await fetchJson(url);
                if (json && json[idObj.id] && json[idObj.id].success) {
                    const data = json[idObj.id].data;
                    if (!data) return null;
                    if (data.is_free) return { free: true };
                    if (data.price_overview) {
                        // final expressed in cents (or minimal unit) and currency code
                        // price_overview.final / 100 -> major units
                        const p = data.price_overview;
                        const amount = (p.final || 0) / (p.currency && p.currency.toUpperCase() === 'KZT' ? 100 : (p.final ? 100 : 1));
                        // Note: Steam returns final in cents for many currencies; assume divide by 100
                        return { amount: amount, currency: p.currency || 'KZT' };
                    }
                }
            } else if (idObj.type === 'package') {
                const url = PACKAGE_API(idObj.id, 'kz');
                const json = await fetchJson(url);
                if (json && json[idObj.id] && json[idObj.id].success) {
                    const data = json[idObj.id].data;
                    // packagedetails response: may include price (final) or price with currency
                    if (data && data.price && data.price.final) {
                        // final cents
                        const p = data.price;
                        const amount = (p.final || 0) / 100;
                        return { amount: amount, currency: p.currency || 'KZT' };
                    }
                }
            }
        } catch (e) {
            log('fetchKzPriceForId error', e);
        }
        return null;
    }

    // Получить курс конвертации from -> to
    async function convertCurrency(amount, from, to) {
        if (!from || !to) return null;
        if (from.toUpperCase() === to.toUpperCase()) return amount;
        try {
            const url = EXCHANGERATE(from.toUpperCase(), to.toUpperCase());
            const j = await fetchJson(url);
            if (j && j.success) {
                return j.result * amount;
            }
        } catch (e) {
            log('convertCurrency error', e);
        }
        return null;
    }

    /*******************************
     * Основная логика: найти прайсы и дописать KZ/RUB
     *******************************/
    // Список селекторов цен в Steam, покрывающий большинство мест
    const PRICE_SELECTORS = [
        '.game_purchase_price',         // основной ценник
        '.price',                       // общий селектор
        '.discount_final_price',        // цена со скидкой
        '.discount_original_price',
        '.discount_original_price .price',
        '.discount_final_price .price',
        '.bundle_price',                // пакеты
        '.package_price',               // пакетные страницы
        '.sysreq_leftcol .game_area_purchase_game .price' // запасной
    ];

    function findPriceElements() {
        const elems = new Set();
        PRICE_SELECTORS.forEach(sel => {
            document.querySelectorAll(sel).forEach(e => elems.add(e));
        });
        // также могут быть элементы с классами вида ".buy_price" или span с data-price
        document.querySelectorAll('[data-price], [data-buy-price]').forEach(e => elems.add(e));
        return Array.from(elems).filter(e => e && e.offsetParent !== null);
    }

    function attachBadgeToElement(el, contentHtml) {
        // проверим, чтобы не добавить дубликаты
        if (!el) return;
        // Создаем span .kz-price-badge
        let existing = el.querySelector('.kz-price-badge') || (el.parentElement && el.parentElement.querySelector && el.parentElement.querySelector('.kz-price-badge'));
        if (existing) {
            existing.innerHTML = contentHtml;
            return existing;
        }
        const span = document.createElement('span');
        span.className = 'kz-price-badge';
        span.style.cssText = 'margin-left:8px;font-size:90%;opacity:0.95;color:#d7dbdf;background:transparent;';
        span.innerHTML = contentHtml;
        // try append after price text
        try {
            // place after element
            if (el.parentElement) el.parentElement.insertBefore(span, el.nextSibling);
            else el.appendChild(span);
        } catch (e) {
            el.appendChild(span);
        }
        return span;
    }

    // Посчитать и отрисовать для всех найденных ценников
    async function processPricesOnce(retry = 0) {
        try {
            const priceEls = findPriceElements();
            if (!priceEls || priceEls.length === 0) {
                if (retry < MAX_RETRIES) {
                    log('No price elements found, retry', retry);
                    setTimeout(() => processPricesOnce(retry + 1), PRICE_CHECK_DELAY_MS);
                }
                return;
            }
            log('Found price elements:', priceEls.length);

            // определим текущую валюту на странице по первому ценнику
            let firstParsed = null;
            for (const el of priceEls) {
                const txt = el.innerText || el.textContent || el.getAttribute('data-price') || '';
                const parsed = parsePriceText(txt);
                if (parsed) { firstParsed = parsed; break; }
            }

            // Если не определили валюту, пробуем поиск символов на странице
            let currentCurrency = (firstParsed && firstParsed.currency) ? firstParsed.currency : null;
            // fallback: если в URL есть cc=kz или cc=ru
            const u = new URL(window.location.href);
            const cc = u.searchParams.get('cc');
            if (!currentCurrency && cc) {
                if (cc.toLowerCase() === 'kz') currentCurrency = 'KZT';
                if (cc.toLowerCase() === 'ru') currentCurrency = 'RUB';
            }

            // Получаем id продукта (app/package)
            const idObj = getIdsFromUrl();
            log('detected idObj', idObj);

            // Если текущая валюта KZT или цена содержит KZT, тогда просто конвертим в RUB и показываем (старый функционал)
            // Иначе, если текущая валюта RUB (RU-страница), то пробуем получить реальную KZ-цену через API и показать её в рублях + процент
            let needKzFromApi = false;
            if (currentCurrency && currentCurrency.toUpperCase() === 'KZT') {
                // просто конвертируем KZT -> RUB и добавляем рядом
                log('Page shows KZT — will convert to RUB inline.');
                // Получим курс KZT->RUB один раз
                let rate = null;
                // We'll convert individually per price using exchangerate endpoint
                for (const el of priceEls) {
                    try {
                        const txt = el.innerText || el.textContent || '';
                        const parsed = parsePriceText(txt);
                        if (!parsed) continue;
                        const kzAmount = parsed.value;
                        // получить курс и конвертировать
                        const conv = await convertCurrency(kzAmount, 'KZT', 'RUB');
                        let content = '';
                        if (conv != null) {
                            const rounded = Math.round(conv);
                            content = `<strong>${formatMoney(rounded, 'RUB')}</strong> (из ${formatMoney(kzAmount, 'KZT')})`;
                        } else {
                            content = `(≈ ${formatMoney(kzAmount, 'KZT')} → ? RUB)`;
                        }
                        attachBadgeToElement(el, content);
                    } catch (e) {
                        log('error processing KZT element', e);
                    }
                }
                return;
            } else {
                // currentCurrency not KZT. If RU or unknown -> try fetch KZ price via API
                needKzFromApi = true;
            }

            if (needKzFromApi && idObj) {
                const kzInfo = await fetchKzPriceForId(idObj);
                log('kzInfo', kzInfo);
                if (!kzInfo) {
                    log('No kz price info available via API.');
                    // optionally remove badges if any
                    priceEls.forEach(el => attachBadgeToElement(el, '(KZ: недоступно)'));
                    return;
                }
                if (kzInfo.free) {
                    priceEls.forEach(el => attachBadgeToElement(el, '(KZ: бесплатно)'));
                    return;
                }
                // kzInfo.amount is in KZ currency units, kzInfo.currency is likely 'KZT'
                const kzCurrency = (kzInfo.currency || 'KZT').toUpperCase();
                const kzAmount = kzInfo.amount;

                // конвертировать KZ->RUB
                const kzToRub = await convertCurrency(kzAmount, kzCurrency, 'RUB');

                // определить текущ RU-цену для расчёта delta (возьмём первый парный priceEl)
                // возьмём значение из firstParsed если это RUB
                let ruValue = null;
                if (firstParsed && firstParsed.currency && firstParsed.currency.toUpperCase() === 'RUB') {
                    ruValue = firstParsed.value;
                } else {
                    //
