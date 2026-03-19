const fs = require("fs");

const FILE = "./keys.json";

// load keys
function loadKeys() {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE));
}

// save keys
function saveKeys(data) {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// generate random key
function generateKey() {
    return "angel-" + Math.random().toString(36).substring(2, 10);
}

// create key with expiry (in hours)
function createKey(hours = 24) {
    const keys = loadKeys();
    const key = generateKey();

    const expire = Date.now() + hours * 3600000;

    keys[key] = {
        expires: expire
    };

    saveKeys(keys);
    return key;
}

// check key
function isValid(key) {
    const keys = loadKeys();
    if (!keys[key]) return false;

    if (Date.now() > keys[key].expires) {
        delete keys[key];
        saveKeys(keys);
        return false;
    }

    return true;
}

module.exports = {
    createKey,
    isValid
};
