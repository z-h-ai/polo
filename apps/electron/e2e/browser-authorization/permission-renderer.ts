/** Production confirmation component connected to the owned E2E Host RPC. */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { PermissionRequest } from '../../src/renderer/components/app-shell/input/structured/PermissionRequest';
import zh from '../../../../packages/shared/src/i18n/locales/zh-Hans.json';
const i18n = createInstance();
void i18n.use(initReactI18next).init({ lng: 'zh-Hans', resources: { 'zh-Hans': { translation: zh } }, interpolation: { escapeValue: false } });
function Confirmation() {
    const [request, setRequest] = useState<any>();
    useEffect(() => {
        let active = true;
        void fetch('/permission').then(r => r.json()).then(r => {
            if (active)
                setRequest(r);
        });
        return () => { active = false; };
    }, []);
    if (!request)
        return React.createElement("p", null, "\u6B63\u5728\u8BFB\u53D6\u64CD\u4F5C\u786E\u8BA4\u2026");
    return React.createElement(I18nextProvider, { i18n: i18n },
        React.createElement("main", { className: "min-h-screen flex items-end p-4 bg-background" },
            React.createElement("section", { className: "w-full", "data-request-id": request.requestId },
                React.createElement(PermissionRequest, { request: request, onResponse: response => {
                        void fetch('/permission/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: request.requestId, ...response }) }).then(r => r.json()).then(result => {
                            if (!result.accepted)
                                throw Error('Host rejected confirmation');
                        });
                    } }))));
}
createRoot(document.getElementById('root')!).render(React.createElement(Confirmation, null));
