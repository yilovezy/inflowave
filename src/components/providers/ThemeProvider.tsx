import React, { createContext, useContext, useEffect, useState } from 'react';
import { applyThemeColors } from '@/lib/theme-colors';
import { useAppStore } from '@/store/app';
import { isTauriEnvironment } from '@/utils/tauri';

import { logger } from '@/utils/logger';
type Theme = 'dark' | 'light' | 'system';

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  defaultColorScheme?: string;
  colorSchemeStorageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  colorScheme: string;
  setColorScheme: (colorScheme: string) => void;
  resolvedTheme: 'light' | 'dark';
};

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null,
  colorScheme: 'default',
  setColorScheme: () => null,
  resolvedTheme: 'light',
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'vite-ui-theme',
  defaultColorScheme = 'default',
  colorSchemeStorageKey = 'vite-ui-color-scheme',
  ...props
}: ThemeProviderProps) {
  const { config } = useAppStore();

  // 从 useAppStore 获取主题，如果没有则使用 localStorage 或默认值
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      // 优先使用 useAppStore 中的主题
      if (config?.theme) {
        return config.theme as Theme;
      }
      return (localStorage.getItem(storageKey) as Theme) || defaultTheme;
    }
    return defaultTheme;
  });

  const [colorScheme, setColorScheme] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(colorSchemeStorageKey) || defaultColorScheme;
    }
    return defaultColorScheme;
  });

  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  // 同步Tauri应用主题的函数（提取到组件级别以便复用）
  const syncTauriAppTheme = React.useCallback(async (themeValue: 'light' | 'dark') => {
    logger.render(`[ThemeProvider] 准备同步Tauri应用主题: ${themeValue}`);

    if (typeof window === 'undefined') {
      logger.warn('[ThemeProvider] window 未定义，跳过主题同步');
      return;
    }

    // 检查环境详情
    const envDetails = {
      __TAURI__: !!(window as any).__TAURI__,
      __TAURI_INTERNALS__: !!(window as any).__TAURI_INTERNALS__,
      userAgent: navigator.userAgent,
      protocol: window.location.protocol,
      isTauriEnv: isTauriEnvironment()
    };

    logger.debug('[ThemeProvider] 环境检测详情:', envDetails);

    // 尝试直接调用 API，不依赖环境检测
    try {
      logger.debug('📦 [ThemeProvider] 尝试导入 app API...');
      const { setTheme } = await import('@tauri-apps/api/app');

      logger.debug(`🔧 [ThemeProvider] 调用 setTheme(${themeValue})...`);
      await setTheme(themeValue);

      logger.info(`[ThemeProvider] Tauri应用主题已成功同步为: ${themeValue}`);

      // 在 macOS 上，额外设置窗口背景色以匹配主题
      if (isTauriEnvironment()) {
        try {
          logger.render('[ThemeProvider] 尝试设置窗口背景色...');
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('set_window_background', { theme: themeValue });
          logger.info(`[ThemeProvider] 窗口背景色已设置为: ${themeValue}`);
        } catch (bgError) {
          logger.warn('[ThemeProvider] 设置窗口背景色失败:', bgError);
        }
      }
    } catch (error) {
      // 只在真正的 Tauri 环境中才报错，否则静默跳过
      if (isTauriEnvironment()) {
        logger.error('[ThemeProvider] 同步Tauri应用主题失败:', error);
      } else {
        logger.debug('ℹ️ [ThemeProvider] 非Tauri环境，跳过主题同步');
      }
    }
  }, []);

  // 初始化时立即同步Tauri窗口主题
  useEffect(() => {
    const initializeTheme = async () => {
      logger.debug(`🚀 [ThemeProvider] 初始化主题同步，当前theme配置: ${theme}`);

      // 确定初始主题
      let initialTheme: 'light' | 'dark' = 'light';

      if (theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        initialTheme = isDark ? 'dark' : 'light';
        logger.debug(`🖥️ [ThemeProvider] 系统主题检测: ${initialTheme} (isDark: ${isDark})`);
      } else if (theme === 'light' || theme === 'dark') {
        initialTheme = theme;
        logger.debug(`🎯 [ThemeProvider] 使用指定主题: ${initialTheme}`);
      }

      logger.debug(`[ThemeProvider] 准备初始化同步主题: ${initialTheme}`);
      // 立即同步到Tauri应用
      await syncTauriAppTheme(initialTheme);
    };

    initializeTheme();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 只在组件挂载时执行一次

  // 同步 useAppStore 中的主题变化
  useEffect(() => {
    if (config?.theme && config.theme !== theme) {
      setTheme(config.theme as Theme);
    }
  }, [config?.theme, theme]);

  // 🔧 分离主题模式（light/dark）和配色方案（zinc/slate等）的处理
  // 主题模式变化时需要同步到 Tauri，配色方案变化只需要更新 CSS 变量
  useEffect(() => {
    logger.debug(`[ThemeProvider] 主题模式effect触发，theme: ${theme}`);

    const root = window.document.documentElement;

    // 移除之前的主题类
    root.classList.remove('light', 'dark');

    let currentTheme: 'light' | 'dark' = 'light';

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
        .matches
        ? 'dark'
        : 'light';

      logger.debug(`🖥️ [ThemeProvider] 系统主题模式: ${systemTheme}`);

      root.classList.add(systemTheme);
      currentTheme = systemTheme;
      setResolvedTheme(systemTheme);

      // 🔧 只在主题模式变化时同步Tauri应用主题
      logger.debug(`📤 [ThemeProvider] 同步系统主题到Tauri: ${systemTheme}`);
      syncTauriAppTheme(systemTheme);

      // 监听系统主题变化
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => {
        if (theme === 'system') {
          const newSystemTheme = mediaQuery.matches ? 'dark' : 'light';
          root.classList.remove('light', 'dark');
          root.classList.add(newSystemTheme);
          setResolvedTheme(newSystemTheme);

          // 🔧 只在主题模式变化时同步Tauri应用主题
          syncTauriAppTheme(newSystemTheme);

          // 强制触发重新渲染，确保所有组件都能响应主题变化
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('theme-changed', {
              detail: { theme: newSystemTheme }
            }));
          }, 0);
        }
      };

      // Safari 13 (macOS 10.15) 兼容：MediaQueryList 没有 addEventListener
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleChange);
        return () => mediaQuery.removeEventListener('change', handleChange);
      } else {
        (mediaQuery as any).addListener(handleChange);
        return () => (mediaQuery as any).removeListener(handleChange);
      }
    } else {
      // 确保theme不是空字符串
      if (theme && theme.trim() && (theme === 'light' || theme === 'dark')) {
        logger.debug(`🎯 [ThemeProvider] 使用指定主题: ${theme}`);
        root.classList.add(theme);
        currentTheme = theme as 'light' | 'dark';
        setResolvedTheme(theme as 'light' | 'dark');
      } else {
        // 如果theme为空或无效，使用默认的light主题
        logger.warn(`[ThemeProvider] 主题值无效 (${theme})，使用默认light主题`);
        root.classList.add('light');
        currentTheme = 'light';
        setResolvedTheme('light');
      }

      // 🔧 只在主题模式变化时同步Tauri应用主题
      logger.debug(`📤 [ThemeProvider] 同步指定主题到Tauri: ${currentTheme}`);
      syncTauriAppTheme(currentTheme);
    }
  }, [theme, syncTauriAppTheme]); // 🔧 移除 colorScheme 依赖，避免配色方案变化时触发 Tauri 同步

  // 🔧 单独处理配色方案变化，只更新 CSS 变量
  useEffect(() => {
    logger.render(`[ThemeProvider] 配色方案effect触发，colorScheme: ${colorScheme}, resolvedTheme: ${resolvedTheme}`);
    applyThemeColors(colorScheme, resolvedTheme === 'dark');
  }, [colorScheme, resolvedTheme]); // 🔧 配色方案变化时只更新 CSS 变量，不触发 Tauri 同步

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme);
      setTheme(theme);
      // 同步到 useAppStore
      const { setConfig } = useAppStore.getState();
      setConfig({ theme });
    },
    colorScheme,
    setColorScheme: (colorScheme: string) => {
      localStorage.setItem(colorSchemeStorageKey, colorScheme);
      setColorScheme(colorScheme);
    },
    resolvedTheme,
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error('useTheme must be used within a ThemeProvider');

  return context;
};

// 兼容性hook，保持与现有代码的兼容性
export const useColorScheme = () => {
  const { colorScheme, setColorScheme } = useTheme();
  return { colorScheme, setColorScheme };
};
