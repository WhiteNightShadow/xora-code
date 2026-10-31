function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

export function mailer() {
    return { host: required('SMTP_HOST'), from: process.env.MAIL_FROM ?? 'orders@example.com' };
}
