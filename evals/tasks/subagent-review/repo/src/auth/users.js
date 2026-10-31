const USERS = [{ name: 'admin', passwordMd5: '21232f297a57a5a743894a0e4a801fc3', role: 'admin' }];

export function findUser(name) {
    return USERS.find((user) => user.name === name);
}
