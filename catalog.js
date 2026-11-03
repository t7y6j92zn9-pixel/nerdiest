// Каталог вещей, звания и экономика. Общий для сервера и приложения.
// Хочешь добавить вещь — допиши строку сюда, цена в сигаретах.
(function (root) {
  const ITEMS = [
    // Головной убор
    { id: 'hat_none', cat: 'hat', name: 'Без шапки', price: 0 },
    { id: 'hat_knit', cat: 'hat', name: 'Чёрная вязаная шапка', price: 150 },
    { id: 'hat_cap', cat: 'hat', name: 'Кепка-восьмиклинка', price: 400 },
    { id: 'hat_ushanka', cat: 'hat', name: 'Ушанка', price: 700 },
    { id: 'hat_bandana', cat: 'hat', name: 'Бандана', price: 300 },
    // Верх
    { id: 'top_tank', cat: 'top', name: 'Майка-алкоголичка', price: 0 },
    { id: 'top_none', cat: 'top', name: 'Голый торс (видно наколки)', price: 0 },
    { id: 'top_robe', cat: 'top', name: 'Роба с номером', price: 200 },
    { id: 'top_vest', cat: 'top', name: 'Тельняшка', price: 350 },
    { id: 'top_track', cat: 'top', name: 'Спортивный костюм', price: 600 },
    { id: 'top_jacket', cat: 'top', name: 'Телогрейка', price: 900 },
    { id: 'top_leather', cat: 'top', name: 'Кожаная куртка', price: 2000 },
    // Лицо
    { id: 'face_clean', cat: 'face', name: 'Гладко выбрит', price: 0 },
    { id: 'face_stubble', cat: 'face', name: 'Щетина', price: 50 },
    { id: 'face_mustache', cat: 'face', name: 'Усы', price: 250 },
    { id: 'face_beard', cat: 'face', name: 'Борода', price: 500 },
    { id: 'face_scar', cat: 'face', name: 'Шрам через бровь', price: 800 },
    // Татуировки (можно набить несколько, по одной на место)
    { id: 'tat_rose', cat: 'tattoo', slot: 'armL', name: 'Роза на руке', price: 200 },
    { id: 'tat_anchor', cat: 'tattoo', slot: 'armR', name: 'Якорь на руке', price: 200 },
    { id: 'tat_spider', cat: 'tattoo', slot: 'neck', name: 'Паутина на шее', price: 450 },
    { id: 'tat_cat', cat: 'tattoo', slot: 'chest', name: 'Кот на груди', price: 600 },
    { id: 'tat_domes', cat: 'tattoo', slot: 'chest', name: 'Купола на груди', price: 1500 },
    { id: 'tat_dagger', cat: 'tattoo', slot: 'armR', name: 'Кинжал на руке', price: 700 },
    { id: 'tat_dice', cat: 'tattoo', slot: 'armL', name: 'Кости на руке', price: 500 },
    { id: 'tat_rings', cat: 'tattoo', slot: 'hand', name: 'Перстни на пальцах', price: 900 },
    // Доска для нард
    { id: 'board_classic', cat: 'board', name: 'Классика', price: 0 },
    { id: 'board_cardboard', cat: 'board', name: 'Самодельная из картона', price: 100 },
    { id: 'board_green', cat: 'board', name: 'Зелёное сукно', price: 500 },
    { id: 'board_ebony', cat: 'board', name: 'Чёрное дерево', price: 1200 },
    { id: 'board_gold', cat: 'board', name: 'Золотая резная', price: 3500 },
    // Хата: нары
    { id: 'bunk_iron', cat: 'bunk', name: 'Железные нары', price: 0 },
    { id: 'bunk_wood', cat: 'bunk', name: 'Деревянные нары', price: 300 },
    { id: 'bunk_soft', cat: 'bunk', name: 'Нары с ватным матрасом', price: 800 },
    { id: 'bunk_king', cat: 'bunk', name: 'Шконка у окна с ковром', price: 2500 },
    // Хата: стена
    { id: 'wall_bare', cat: 'wall', name: 'Голая стена', price: 0 },
    { id: 'wall_calendar', cat: 'wall', name: 'Календарь с зачёркнутыми днями', price: 150 },
    { id: 'wall_window', cat: 'wall', name: 'Окно с решёткой и луной', price: 400 },
    { id: 'wall_icon', cat: 'wall', name: 'Самодельная иконка', price: 700 },
    { id: 'wall_carpet', cat: 'wall', name: 'Ковёр на стене', price: 1500 },
    // Хата: на столе
    { id: 'table_none', cat: 'table', name: 'Пустой стол', price: 0 },
    { id: 'table_mug', cat: 'table', name: 'Кружка чифира', price: 100 },
    { id: 'table_radio', cat: 'table', name: 'Радиоприёмник', price: 600 },
    { id: 'table_tv', cat: 'table', name: 'Маленький телевизор', price: 1800 },
  ];
  const CATS = [
    { id: 'top', name: 'Одежда' }, { id: 'hat', name: 'Шапки' }, { id: 'face', name: 'Лицо' },
    { id: 'tattoo', name: 'Тату' }, { id: 'board', name: 'Нарды' },
    { id: 'bunk', name: 'Нары' }, { id: 'wall', name: 'Стена' }, { id: 'table', name: 'Стол' },
  ];
  // Звания по рейтингу
  const RANKS = [
    { min: 0, name: 'Первоход' },
    { min: 100, name: 'Мужик' },
    { min: 300, name: 'Бывалый' },
    { min: 600, name: 'Бродяга' },
    { min: 1000, name: 'Блатной' },
    { min: 1500, name: 'Положенец' },
    { min: 2200, name: 'Вор' },
    { min: 3000, name: 'Вор в законе' },
  ];
  // Фиксированные очки рейтинга. Индекс — множитель победы: 1 обычная, 2 марс, 3 кокс
  const RATING = { win: { 1: 20, 2: 40, 3: 60 }, loss: { 1: -10, 2: -20, 3: -30 }, resign: -30 };
  const ECON = {
    startCigs: 500,      // стартовый капитал
    dailyBonus: 100,     // ежедневный бонус
    botWin: 15,          // награда за победу над ботом (умножается на марс)
    onlineWin: 40,       // награда за победу онлайн сверх ставки
    stakes: [0, 10, 50, 100, 250, 500], // ставки на выбор
    startRating: 0,
  };
  const DEFAULT_EQUIP = { hat: 'hat_none', top: 'top_tank', face: 'face_clean', board: 'board_classic', bunk: 'bunk_iron', wall: 'wall_bare', table: 'table_none', tattoos: {} };
  function rankOf(rating) { let r = RANKS[0]; for (const x of RANKS) if (rating >= x.min) r = x; return r.name; }
  function item(id) { return ITEMS.find(x => x.id === id); }
  const api = { ITEMS, CATS, RANKS, RATING, ECON, DEFAULT_EQUIP, rankOf, item };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Catalog = api;
})(this);
