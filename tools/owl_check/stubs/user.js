// @web/core/user
export const user = {
    get userId() {
        return globalThis.__usuarioId || 2;
    },
};
