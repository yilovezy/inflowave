import { isTauriEnvironment, safeTauriInvokeVoid } from './tauri';

export const triggerNativeWindowResize = async () => {
    try {
        if (!isTauriEnvironment()) return;
        
        // 优先通过 Rust 后端执行原生窗口重排（100% 权限保证且无跨层通信限制）
        await safeTauriInvokeVoid('trigger_native_window_resize');
        console.log("Applied native WKWebView resize hack via backend command");
    } catch (e) {
        console.error("Failed to apply native resize hack via backend", e);
        try {
            const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
            const { PhysicalSize } = await import('@tauri-apps/api/dpi');
            
            const win = getCurrentWebviewWindow();
            const size = await win.innerSize();
            await win.setSize(new PhysicalSize(size.width, size.height + 1));
            setTimeout(() => {
                win.setSize(new PhysicalSize(size.width, size.height));
            }, 50);
        } catch (err) {
            console.error("Fallback native resize hack also failed", err);
        }
    }
};

