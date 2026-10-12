// 把舊版 JSON 資料檔（data/db.json）搬進 SQLite。整個搬遷在同一個交易內，失敗會整筆回復，不會留下半套資料。

function importLegacyJson(store, legacy) {
  const counts = { employees: 0, bindings: 0, admins: 0, kiosks: 0, menuDays: 0, orders: 0, exemptions: 0, history: 0 };

  store.tx(() => {
    Object.entries(legacy.config || {}).forEach(([key, value]) => {
      if (key in store.DEFAULT_CONFIG) store.setConfig(key, value);
    });

    Object.values(legacy.employees || {}).forEach((e) => {
      store.employees.upsert({ id: e.id, name: e.name, dept: e.dept || '', verify: e.verify });
      counts.employees += 1;
    });

    Object.entries(legacy.bindings || {}).forEach(([lineUserId, b]) => {
      store.bindings.upsert({ lineUserId, employeeId: b.employeeId, displayName: b.displayName || '', boundAt: b.boundAt });
      counts.bindings += 1;
    });

    Object.values(legacy.admins || {}).forEach((a) => {
      store.admins.save({
        username: a.username, displayName: a.displayName, role: a.role, active: a.active !== false,
        salt: a.salt, hash: a.hash, createdAt: a.createdAt || new Date().toISOString(),
      });
      counts.admins += 1;
    });

    Object.values(legacy.kiosks || {}).forEach((k) => {
      store.kiosks.save({
        id: k.id, name: k.name, active: k.active !== false, salt: k.salt, hash: k.hash,
        createdAt: k.createdAt || new Date().toISOString(), lastSeen: k.lastSeen || null,
      });
      counts.kiosks += 1;
    });

    Object.entries(legacy.menus || {}).forEach(([date, items]) => {
      if (!items || items.length === 0) return;
      store.menus.set(date, items);
      counts.menuDays += 1;
    });

    (legacy.orders || []).forEach((o) => {
      store.orders.insert({ ...o, special: Boolean(o.special) });
      counts.orders += 1;
    });

    Object.entries(legacy.exemptions || {}).forEach(([date, byEmployee]) => {
      Object.entries(byEmployee || {}).forEach(([employeeId, reason]) => {
        store.exemptions.set(date, employeeId, reason);
        counts.exemptions += 1;
      });
    });

    (legacy.history || []).forEach((h) => {
      store.history.add(h.action, h.detail, h.at);
      counts.history += 1;
    });

    if (Number.isInteger(legacy.seq)) store.setSeq(legacy.seq);
  });

  return counts;
}

module.exports = { importLegacyJson };
