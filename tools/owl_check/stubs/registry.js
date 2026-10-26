const cats = {};
export const registry = {
    category(n) {
        return (cats[n] = cats[n] || {add(k, v) { (this.items = this.items || {})[k] = v; }, items: {}});
    },
};
