const teamDisplayNameMap = new Map();

// Chuẩn hóa giá trị để so khớp tên nhóm một cách nhất quán, bỏ khoảng trắng và chuyển về chữ thường.
function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

// Thiết lập bản đồ ánh xạ giữa ID/team name và tên hiển thị để dễ tra cứu khi báo cáo.
export function setTeamDisplayNameMap(teams = []) {
  teamDisplayNameMap.clear();
  teams.forEach((team) => {
    const teamId = team?.id || team;
    const teamName = team?.name || teamId;
    if (teamId) {
      teamDisplayNameMap.set(normalizeKey(teamId), teamName);
      teamDisplayNameMap.set(normalizeKey(teamName), teamName);
    }
  });
}

// Giải quyết tên hiển thị của nhóm từ giá trị đầu vào, trả về 'Chưa phân nhóm' nếu rỗng hoặc không có dữ liệu.
export function resolveTeamDisplayName(value) {
  if (value === undefined || value === null || value === '') {
    return 'Chưa phân nhóm';
  }

  const rawValue = String(value).trim();
  if (!rawValue) {
    return 'Chưa phân nhóm';
  }

  const directMatch = teamDisplayNameMap.get(normalizeKey(rawValue));
  if (directMatch) {
    return directMatch;
  }

  return rawValue;
}

// Lấy tên nhóm phù hợp từ một dòng dữ liệu theo các trường tên có thể tồn tại.
export function getRowTeam(row) {
  const rawValue = row?.teamName || row?.team || row?.teamId || row?.group || row?.to;
  return resolveTeamDisplayName(rawValue);
}
