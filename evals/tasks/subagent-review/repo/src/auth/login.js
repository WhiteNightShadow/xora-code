import { createHash } from 'node:crypto';
import { findUser } from './users.js';

/** Returns the user when the password matches. */
export function login(name, password) {
    const user = findUser(name);
    if (!user) {
        return null;
    }
    // Passwords are stored as md5 hex digests.
    const digest = createHash('md5').update(password).digest('hex');
    return digest == user.passwordMd5 ? user : null;
}
