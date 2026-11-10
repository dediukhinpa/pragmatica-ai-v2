import { describe, expect, test } from 'bun:test';
import {
  enrichmentFromRegistry,
  matchRegistry,
  parseRegistryPage,
  registryKindOfUrl,
  supplierSiteFromHits,
} from '../../../src/kit/domain/supplier-registry';
import { supplierSearchName } from '../../../src/kit/domain/price-draft-name';

// Всё ниже - синтетика: вымышленные компании, ИНН с верной контрольной суммой.
const INN = '1234567894';
const OTHER_INN = '9876543210';
const OGRN = '1027700000001';

/** Разметка в духе checko: JSON-LD Organization + блок контактов. */
const CHECKO_HTML = `<!DOCTYPE html><html><head>
<title>ООО &quot;ЛУНА-ПАК&quot; - Казань - ИНН ${INN}</title>
<script>var tracker = "ИНН 1111111111";</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization",
"name":"ООО \\"ЛУНА-ПАК\\"","legalName":"ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ \\"ЛУНА-ПАК\\"",
"taxID":"${INN}","identifier":[{"@type":"PropertyValue","propertyID":"ОГРН","value":"${OGRN}"},
{"@type":"PropertyValue","propertyID":"ИНН","value":"${INN}"}],
"telephone":"+78435550101","email":"sales@luna-pack.example",
"url":"https://checko.ru/company/luna-pak-${OGRN}",
"address":{"@type":"PostalAddress","streetAddress":"ул. Тестовая, д. 1",
"addressLocality":"г. Казань","addressRegion":"Татарстан"}}</script>
</head><body>
<section id="contacts"><div class="fw-700">Адрес</div>
<strong class="fw-700 d-block mb-1">Телефоны</strong>
<a rel="nofollow" href="tel:+78435550101">+7 843 555-01-01</a><br>
<a rel="nofollow" href="tel:+78435550102">+7 843 555-01-02</a>
<strong class="fw-700 d-block mb-1">Электронная почта</strong>
<a href="mailto:sales@luna-pack.example">sales@luna-pack.example</a><br>
<a href="mailto:support@checko.ru">support@checko.ru</a>
<strong class="fw-700 d-block mt-3 mb-1">Веб-сайт</strong>
<a class="link" href="https://www.luna-pack.example/about?utm=1">luna-pack.example</a>
<div class="fw-700 mb-1">Cоциальные сети</div><a href="https://vk.com/lunapack">vk</a>
<div>Руководитель</div><a href="/person/x">Руководов Иван Петрович</a>
</section></body></html>`;

/** Разметка в духе rusprofile: itemprop и id полей. */
const RUSPROFILE_HTML = `<div id="main" itemscope itemtype="https://schema.org/Organization">
<h1 itemprop="name"> Орех-Сервис </h1>
<span itemprop="legalName"><span id="clip_name-long">ОБЩЕСТВО "ОРЕХ-СЕРВИС"</span></span>
<dd itemprop="taxID"><span class="copy_target" id="clip_inn">${OTHER_INN}</span></dd>
<dd><span class="copy_target" id="clip_ogrn">${OGRN}</span></dd>
<div itemprop="address"><address><span id="clip_address">
<span itemprop="postalCode">420000</span>, <span itemprop="addressRegion">Татарстан</span>,
<span itemprop="addressLocality">город Тюмень</span>,
<span itemprop="streetAddress">ул. Пробная, д.5</span></span></address></div>
<div class="company-info__contact"><a href="tel:+73452000000" itemprop="telephone">
+7 (3452) 00-00-00 </a></div>
<span class="company-info__contact-title">Электронная почта и сайт</span>
<a href="mailto:info@orekh.example">info@orekh.example</a>
<a href="https://orekh.example/" rel="nofollow">orekh.example</a>
</div>`;

/** Разметка без структурных полей: только подписи в тексте (запасной путь). */
const LISTORG_HTML = `<html><head><title>МЁД-ТОРГ, ООО - ИНН ${INN}</title></head><body>
<p><i>ИНН:</i> ${INN}</p><p><i>ОГРН:</i> ${OGRN}</p>
<p><i>Телефон:</i> +7 495 000-11-22</p><p><i>E-mail:</i> zakaz@med-torg.example</p>
<p><i>Сайт:</i> http://med-torg.example</p></body></html>`;

describe('registryKindOfUrl', () => {
  test('страницы компании трёх реестров', () => {
    expect(registryKindOfUrl('https://checko.ru/company/luna-pak-1027700000001')).toBe('checko');
    expect(registryKindOfUrl('https://www.rusprofile.ru/id/4768555')).toBe('rusprofile');
    expect(registryKindOfUrl('https://www.list-org.com/company/11665')).toBe('listorg');
  });

  test('списки, поиск и чужие домены не годятся', () => {
    expect(registryKindOfUrl('https://checko.ru/search?query=x')).toBeNull();
    expect(registryKindOfUrl('https://www.rusprofile.ru/codes')).toBeNull();
    expect(registryKindOfUrl('https://evil.example/company/123')).toBeNull();
    expect(registryKindOfUrl('https://checko.ru.evil.example/company/x')).toBeNull();
  });
});

describe('parseRegistryPage', () => {
  test('checko: JSON-LD и контакты, без руководителя и служебной почты реестра', () => {
    const data = parseRegistryPage(CHECKO_HTML);
    expect(data).not.toBeNull();
    expect(data?.inn).toBe(INN);
    expect(data?.ogrn).toBe(OGRN);
    expect(data?.city).toBe('Казань');
    expect(data?.address).toBe('ул. Тестовая, д. 1');
    expect(data?.phones).toEqual(['+7 843 555-01-01', '+7 843 555-01-02']);
    expect(data?.emails).toEqual(['sales@luna-pack.example']);
    expect(data?.site).toBe('https://www.luna-pack.example');
    expect(JSON.stringify(data)).not.toContain('Руководов');
  });

  test('rusprofile: id и itemprop полей', () => {
    const data = parseRegistryPage(RUSPROFILE_HTML);
    expect(data?.inn).toBe(OTHER_INN);
    expect(data?.city).toBe('Тюмень');
    expect(data?.phones).toEqual(['+7 (3452) 00-00-00']);
    expect(data?.emails).toEqual(['info@orekh.example']);
    expect(data?.site).toBe('https://orekh.example');
    expect(data?.names).toContain('Орех-Сервис');
  });

  test('подписи в тексте: запасной путь, название из заголовка', () => {
    const data = parseRegistryPage(LISTORG_HTML);
    expect(data?.inn).toBe(INN);
    expect(data?.phones).toEqual(['+7 495 000-11-22']);
    expect(data?.emails).toEqual(['zakaz@med-torg.example']);
    expect(data?.site).toBe('http://med-torg.example');
    expect(data?.names[0]).toContain('МЁД-ТОРГ');
  });

  test('страница проверки браузера и мусор - null; ИНН без верной суммы в тексте не берётся', () => {
    expect(parseRegistryPage('<html><body>Проверяем браузер…</body></html>')).toBeNull();
    expect(parseRegistryPage('<p>ИНН: 1111111112</p>')).toBeNull();
  });
});

describe('matchRegistry', () => {
  const data = parseRegistryPage(CHECKO_HTML);

  test('ИНН карточки: только тот же ИНН, название не спасает', () => {
    expect(data).not.toBeNull();
    if (data === null) return;
    expect(matchRegistry({ name: 'Совсем другое', inn: INN }, data)).toBe('inn');
    expect(matchRegistry({ name: 'ООО Луна-Пак', inn: OTHER_INN }, data)).toBeNull();
  });

  test('без ИНН - по названию: все значимые слова или первые два', () => {
    if (data === null) throw new Error('нет разбора');
    expect(matchRegistry({ name: 'ООО «Луна-Пак»' }, data)).toBe('name');
    // Хвост из имени файла (товар) не мешает, если первые два слова совпали
    expect(matchRegistry({ name: 'Луна-Пак Коробки' }, data)).toBe('name');
    expect(matchRegistry({ name: 'Луна Коробки' }, data)).toBeNull();
    expect(matchRegistry({ name: 'Луна-Дизайн' }, data)).toBeNull();
    expect(matchRegistry({ name: '' }, data)).toBeNull();
  });

  test('город со страницы в названии карточки не требуется в названии юрлица', () => {
    if (data === null) throw new Error('нет разбора');
    expect(data.city).toBe('Казань');
    expect(matchRegistry({ name: 'Луна-Пак Казань' }, data)).toBe('name');
    // Одного города мало; другой город после первых двух слов - совпадение «проверьте»
    expect(matchRegistry({ name: 'Казань' }, data)).toBeNull();
    expect(matchRegistry({ name: 'Луна-Пак Самара' }, data)).toBe('name');
    expect(matchRegistry({ name: 'Луна Самара' }, data)).toBeNull();
  });
});

describe('сайт компании из выдачи поиска', () => {
  const hits = [
    {
      title: 'Медовый дом - реквизиты',
      url: 'https://checko.ru/company/medovyy-dom-1027700000001',
    },
    { title: 'Медовый дом на Ozon', url: 'https://www.ozon.ru/seller/medovyy-dom-1/' },
    { title: 'Медовый дом — Яндекс Карты', url: 'https://yandex.ru/maps/org/medovyy_dom/1/' },
    { title: 'Медовый дом — Mail.ru', url: 'https://pogoda.mail.ru/medovyy-dom' },
    { title: 'Медовый дом - мёд оптом', url: 'https://medovyy-dom.example.ua/' },
    { title: 'Пасека Иванова', url: 'https://paseka.example/' },
    { title: 'Медовый Дом — натуральный мёд', url: 'https://www.medovdom.example/?ysclid=1' },
  ];

  test('первый результат с названием в заголовке, кроме реестров, площадок и чужих зон', () => {
    expect(supplierSiteFromHits('Медовый дом Мед', hits)).toBe(
      'https://www.medovdom.example/?ysclid=1',
    );
  });

  test('нет совпадения названия или не http(s) - null', () => {
    expect(supplierSiteFromHits('Луна-Пак', hits)).toBeNull();
    const ftp = [{ title: 'Медовый дом', url: 'ftp://medovdom.example' }];
    expect(supplierSiteFromHits('Медовый дом', ftp)).toBeNull();
    expect(supplierSiteFromHits('', hits)).toBeNull();
  });
});

describe('enrichmentFromRegistry и название для запроса', () => {
  test('берёт первые контакты, реквизиты и пометку совпадения', () => {
    const data = parseRegistryPage(CHECKO_HTML);
    if (data === null) throw new Error('нет разбора');
    expect(enrichmentFromRegistry('name', data)).toEqual({
      match: 'name',
      city: 'Казань',
      address: 'ул. Тестовая, д. 1',
      phone: '+7 843 555-01-01',
      email: 'sales@luna-pack.example',
      site: 'https://www.luna-pack.example',
      inn: INN,
      ogrn: OGRN,
    });
  });

  test('из названия черновика убираются «прайс», даты и расширение', () => {
    expect(supplierSearchName('Прайс Луна-Пак 12.10.2026.xlsx')).toBe('Луна Пак');
    expect(supplierSearchName('2026')).toBe('');
  });

  test('для поиска убираются хвосты имени файла: «новинки», «наборы», «каталог»', () => {
    expect(supplierSearchName('Медовый дом Мед новинки')).toBe('Медовый дом Мед');
    expect(supplierSearchName('Тайгарика Наборы')).toBe('Тайгарика');
    expect(supplierSearchName('Луна-Пак каталог 2026 опт')).toBe('Луна Пак');
    // Слово внутри названия не трогается: «Оптима» не «опт»
    expect(supplierSearchName('Оптима Склад-Сервис')).toBe('Оптима Сервис');
  });
});
