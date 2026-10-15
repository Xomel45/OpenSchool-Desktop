'use strict';
// Freezes Object.prototype in this window only. Tauri's own `freezePrototype` would do it in every webview, the Gosuslugi login
// window included, and the Gosuslugi page then never gets past its loading logo. Loaded first, before any of our code.
Object.freeze(Object.prototype);
