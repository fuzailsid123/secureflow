export const SORT_ORDER = {
  priority: 'desc',
  deadline: 'asc',
  credits: 'desc',
  difficulty: 'desc',
};

export function compareBy(key) {
  const direction = SORT_ORDER[key] === 'asc' ? 1 : -1;

  return (a, b) => {
    if (a[key] < b[key]) return -direction;
    if (a[key] > b[key]) return direction;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };
}
