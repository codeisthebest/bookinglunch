// 管理員角色與權限。權限是最小單位，角色只是權限的組合；
// 路由一律檢查「權限」而不是角色名稱，之後要新增角色只需改這裡。

const PERMISSIONS = {
  'report.view': '查看報表、訂單與菜單',
  'report.export': '匯出扣款清單',
  'menu.edit': '維護每日菜單',
  'deduction.manage': '處理扣款狀態與例外名單',
  'employees.manage': '員工名單匯入與 LINE 綁定管理',
  'config.edit': '系統設定（截止時間、補貼、模擬時間）',
  'admins.manage': '管理員帳號與操作紀錄',
};

const ROLES = {
  owner: {
    label: '系統管理員',
    description: '全部功能，包含管理其他管理員帳號',
    permissions: Object.keys(PERMISSIONS),
  },
  operator: {
    label: '營運人員（助理）',
    description: '維護菜單、處理扣款與例外、查看並匯出報表',
    permissions: ['report.view', 'report.export', 'menu.edit', 'deduction.manage'],
  },
  viewer: {
    label: '唯讀',
    description: '只能查看報表、訂單與菜單',
    permissions: ['report.view'],
  },
};

function permissionsOf(role) {
  return ROLES[role] ? ROLES[role].permissions : [];
}

function hasPermission(role, permission) {
  return permissionsOf(role).includes(permission);
}

module.exports = { PERMISSIONS, ROLES, permissionsOf, hasPermission };
