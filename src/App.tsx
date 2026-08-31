import React, { useEffect, useState } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import '@/styles/datagrip.css';
import '@/styles/accessibility.css';
import '@/styles/zebra-tables.css';

// 错误处理
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { errorLogger } from '@/utils/errorLogger';
import { DialogProvider } from '@/components/providers/DialogProvider';

import { safeTauriInvoke, initializeEnvironment } from './utils/tauri';
import { showMessage } from './utils/message';
import GlobalSearch from './components/common/GlobalSearch';
import UserGuideModal from './components/common/UserGuideModal';
import { useNoticeStore } from './store/notice';
import { useConnectionStore } from './store/connection';
import { useUserPreferencesStore } from './stores/userPreferencesStore';
import { useAppNotifications } from './hooks/useAppNotifications';
import { useFontApplier } from './hooks/useFontApplier';
import { useDayjsLocaleSync } from './hooks/useDayjsLocaleSync';
// 移除自动健康检查导入 - 桌面应用不需要定期健康检查
// import { initializeHealthCheck } from './utils/healthCheck';
import { initializeContextMenuDisabler } from './utils/contextMenuDisabler';
import { useTabStore } from './stores/tabStore';
import UnsavedTabsDialog from './components/common/UnsavedTabsDialog';
import type { EditorTab } from '@components/editor';
import { logger, LogLevel, initLoggerWithStore } from './utils/logger';
import { i18n } from '@/i18n';

// 更新组件
import { UpdateNotification } from '@components/updater';
import { useUpdater } from './hooks/useUpdater';

// 页面组件
import DataGripStyleLayout from './components/layout/DataGripStyleLayout';
import NativeMenuHandler from './components/layout/NativeMenuHandler';
import DetachedTabWindow from './components/layout/DetachedTabWindow';

// UI 组件导入
import { Text, Spin, Layout, Content, Toaster } from '@/components/ui';
import { DialogManager } from '@/utils/dialog';
import ConnectionErrorHandler from '@/components/common/ConnectionErrorHandler';
// 主布局组件
const MainLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [globalSearchVisible, setGlobalSearchVisible] = useState(false);
  const [userGuideVisible, setUserGuideVisible] = useState(false);
  const { browserModeNoticeDismissed } = useNoticeStore();

  // 检查是否为分离窗口
  const [detachedTab, setDetachedTab] = useState<any>(null);
  const [detachedTabError, setDetachedTabError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const detachedTabParam = params.get('detached_tab');

    logger.debug('🔍 检查URL参数:', {
      hasDetachedTabParam: !!detachedTabParam,
      paramLength: detachedTabParam?.length || 0,
      fullUrl: window.location.href,
    });

    if (detachedTabParam) {
      try {
        const decodedParam = decodeURIComponent(detachedTabParam);
        logger.debug('📦 解码后的参数:', decodedParam.substring(0, 200));

        const tab = JSON.parse(decodedParam);
        logger.debug('✅ 成功解析detached tab:', {
          tabId: tab.id,
          tabTitle: tab.title,
          tabType: tab.type,
        });

        setDetachedTab(tab);
      } catch (error) {
        logger.error('❌ 解析分离tab参数失败:', error);
        setDetachedTabError(`解析失败: ${error}`);
      }
    }
  }, []);
  
  // 更新功能
  const {
    updateInfo,
    showNotification: showUpdateNotification,
    hideNotification,
    skipVersion: _skipVersion,
  } = useUpdater();

  // 初始化应用通知
  useAppNotifications();

  // 检查是否显示用户指引
  useEffect(() => {
    if (!browserModeNoticeDismissed) {
      // 监听app-ready事件后显示弹框
      const handleAppReady = () => {
        setTimeout(() => setUserGuideVisible(true), 100);
      };
      window.addEventListener('app-ready', handleAppReady);
      const timer = setTimeout(() => {
        setUserGuideVisible(true);
      }, 500); // 减少兜底延迟
      return () => {
        clearTimeout(timer);
        window.removeEventListener('app-ready', handleAppReady);
      };
    }
  }, [browserModeNoticeDismissed]);

  // 监听菜单触发的用户引导事件
  useEffect(() => {
    const handleShowUserGuide = () => {
      setUserGuideVisible(true);
    };

    const handleShowQuickStart = () => {
      setUserGuideVisible(true);
    };

    document.addEventListener('show-user-guide', handleShowUserGuide);
    document.addEventListener('show-quick-start', handleShowQuickStart);
    
    return () => {
      document.removeEventListener('show-user-guide', handleShowUserGuide);
      document.removeEventListener('show-quick-start', handleShowQuickStart);
    };
  }, []);

  // 键盘快捷键处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 检查是否在输入元素中
      const target = e.target as HTMLElement;
      const isInputElement = target.tagName === 'INPUT' ||
                           target.tagName === 'TEXTAREA' ||
                           target.isContentEditable ||
                           target.closest('.cm-editor') ||  // CodeMirror 6
                           target.closest('.cm-content') ||  // CodeMirror 6 content area
                           target.closest('.cm6-editor-container') ||  // CodeMirror 6 container
                           target.closest('.CodeMirror') ||  // Legacy CodeMirror
                           target.closest('[contenteditable="true"]');

      // 不要阻止系统级的复制粘贴快捷键，特别是在输入元素中
      const isSystemClipboard = (
        (e.ctrlKey || e.metaKey) &&
        ['c', 'v', 'x', 'a', 'z', 'y'].includes(e.key.toLowerCase())
      );

      // 如果是输入元素中的系统快捷键，完全不处理
      if (isInputElement && isSystemClipboard) {
        return;
      }

      if (isSystemClipboard) {
        return; // 让系统处理复制粘贴
      }

      // Ctrl+Shift+P 打开全局搜索
      if (e.ctrlKey && e.shiftKey && e.key === 'P') {
        // 如果在输入元素中，不处理全局搜索
        if (isInputElement) {
          return;
        }
        e.preventDefault();
        setGlobalSearchVisible(true);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 🔧 如果解析detached tab失败，显示错误信息
  if (detachedTabError) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold text-destructive mb-4">无法加载独立窗口</h1>
          <p className="text-muted-foreground mb-4">{detachedTabError}</p>
          <p className="text-sm text-muted-foreground">请关闭此窗口并重试</p>
        </div>
      </div>
    );
  }

  // 🔧 如果是分离窗口,直接显示DetachedTabWindow
  if (detachedTab) {
    logger.debug('🪟 渲染DetachedTabWindow组件');
    return (
      <DetachedTabWindow
        tab={detachedTab}
        onClose={async () => {
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const window = getCurrentWindow();
            await window.close();
          } catch (error) {
            logger.error('关闭窗口失败:', error);
          }
        }}
      />
    );
  }

  // 检查是否为需要特殊处理的页面（调试页面等）
  const isSpecialPage = [
    '/debug',
    '/typography-test',
    '/ui-test',
  ].includes(location.pathname);

  if (isSpecialPage) {
    return (
      <>
        {/* 全局菜单处理器 - 确保特殊页面也能处理菜单事件 */}
        <NativeMenuHandler onGlobalSearch={() => setGlobalSearchVisible(true)} />
        
        <Layout className='h-full bg-background'>
          {/* 应用工具栏 */}

          {/* 主内容区 */}
          <Content className='flex-1 p-4'>
            <Routes>
              {/* 特殊页面路由将在这里添加 */}
            </Routes>
          </Content>

          {/* 全局搜索 */}
          <GlobalSearch
            isOpen={globalSearchVisible}
            onClose={() => setGlobalSearchVisible(false)}
            onNavigate={(path, params) => {
              navigate(path, { state: params });
            }}
            onExecuteQuery={query => {
              navigate('/query', { state: { query } });
            }}
          />
        </Layout>
      </>
    );
  }

  // 对于主要的数据库工作区页面，使用DataGrip风格布局
  return (
    <>
      {/* 全局菜单处理器 - 确保在所有页面都能处理菜单事件 */}
      <NativeMenuHandler onGlobalSearch={() => setGlobalSearchVisible(true)} />

      <Routes>
        {/* 所有主要功能页面都使用DataGrip风格布局，内部根据路径动态切换视图 */}
        <Route path='/*' element={<DataGripStyleLayout />} />
      </Routes>

      {/* 用户指引弹框 */}
      <UserGuideModal
        isOpen={userGuideVisible}
        onClose={() => setUserGuideVisible(false)}
      />

      {/* 更新通知 */}
      <UpdateNotification
        open={showUpdateNotification}
        updateInfo={updateInfo}
        onOpenChange={hideNotification}
      />
    </>
  );
};

const App: React.FC = () => {
  const [showUnsavedTabsDialog, setShowUnsavedTabsDialog] = useState(false);
  const [unsavedTabs, setUnsavedTabs] = useState<EditorTab[]>([]);
  const { preferences, loadUserPreferences } = useUserPreferencesStore();

  // 🛡️ 防止初始化被多次执行
  const initializationStarted = React.useRef(false);
  const initializationCompleted = React.useRef(false);

  // 🎨 应用字体设置（实时响应用户偏好变化）
  useFontApplier();
  
  // 🌐 同步 dayjs locale 与 i18n 语言
  useDayjsLocaleSync();

  // 🔧 初始化日志系统与用户偏好设置的同步（仅执行一次）
  useEffect(() => {
    // 初始化日志系统与 store 的订阅
    // 这会自动处理日志设置变化的动态更新
    initLoggerWithStore();
  }, []);

  // 应用无障碍设置到 DOM（高对比度和减少动画）
  // 注意：字体设置已由 useFontApplier hook 处理
  useEffect(() => {
    if (!preferences?.accessibility) return;

    const { high_contrast, reduced_motion } = preferences.accessibility;
    const body = document.body;

    // 高对比度设置
    if (high_contrast) {
      body.classList.add('high-contrast');
    } else {
      body.classList.remove('high-contrast');
    }

    // 减少动画设置
    if (reduced_motion) {
      body.classList.add('reduced-motion');
    } else {
      body.classList.remove('reduced-motion');
    }

    logger.debug('已应用无障碍设置:', { high_contrast, reduced_motion });
  }, [preferences?.accessibility]);

  // 应用工作区设置到 DOM
  useEffect(() => {
    if (!preferences?.workspace) return;

    const { layout } = preferences.workspace;
    const body = document.body;

    // 布局模式设置
    body.classList.remove('layout-compact', 'layout-comfortable', 'layout-spacious', 'layout-minimal');
    switch (layout) {
      case 'compact':
        body.classList.add('layout-compact');
        break;
      case 'comfortable':
        body.classList.add('layout-comfortable');
        break;
      case 'spacious':
        body.classList.add('layout-spacious');
        break;
      case 'minimal':
        body.classList.add('layout-minimal');
        break;
      default:
        body.classList.add('layout-comfortable');
        break;
    }

    logger.debug('已应用工作区设置:', { layout });
  }, [preferences?.workspace]);

  // 处理未保存标签页对话框事件
  useEffect(() => {
    const handleShowDialog = (event: CustomEvent) => {
      const { unsavedTabs } = event.detail;
      setUnsavedTabs(unsavedTabs);
      setShowUnsavedTabsDialog(true);
    };

    window.addEventListener('show-unsaved-tabs-dialog', handleShowDialog as (event: Event) => void);

    return () => {
      window.removeEventListener('show-unsaved-tabs-dialog', handleShowDialog as (event: Event) => void);
    };
  }, []);

  // 处理对话框用户选择
  const handleDialogSave = () => {
    setShowUnsavedTabsDialog(false);
    const event = new CustomEvent('unsaved-tabs-dialog-result', {
      detail: { action: 'save' }
    });
    window.dispatchEvent(event);
  };

  const handleDialogDiscard = () => {
    setShowUnsavedTabsDialog(false);
    const event = new CustomEvent('unsaved-tabs-dialog-result', {
      detail: { action: 'discard' }
    });
    window.dispatchEvent(event);
  };

  const handleDialogCancel = () => {
    setShowUnsavedTabsDialog(false);
    const event = new CustomEvent('unsaved-tabs-dialog-result', {
      detail: { action: 'cancel' }
    });
    window.dispatchEvent(event);
  };

  // 监听语言变化，更新所有 tab 标题
  useEffect(() => {
    const handleLanguageChange = () => {
      const { updateAllTabTitles } = useTabStore.getState();
      updateAllTabTitles();
      logger.debug('语言已切换，已更新所有 tab 标题');
    };

    // 监听 i18n 语言变化事件
    i18n.on('languageChanged', handleLanguageChange);

    return () => {
      i18n.off('languageChanged', handleLanguageChange);
    };
  }, []);

  // 处理应用关闭事件
  useEffect(() => {
    const handleBeforeUnload = async (event: BeforeUnloadEvent) => {
      const { handleAppClose } = useTabStore.getState();

      try {
        const canClose = await handleAppClose();
        if (!canClose) {
          event.preventDefault();
          event.returnValue = ''; // 标准做法
        }
      } catch (error) {
        logger.error('处理应用关闭失败:', error);
      }
    };

    // 监听浏览器关闭事件
    window.addEventListener('beforeunload', handleBeforeUnload);

    // 如果是Tauri环境，也监听Tauri的关闭事件
    if ((window as any).__TAURI__) {
      try {
        import('@tauri-apps/api/event').then(({ listen }) => {
          listen('tauri://close-requested', async () => {
            const { handleAppClose } = useTabStore.getState();
            try {
              const canClose = await handleAppClose();
              if (canClose) {
                // 允许关闭应用 - 使用正确的webview window API
                import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
                  getCurrentWebviewWindow().close();
                }).catch(err => {
                  logger.warn('无法关闭Tauri窗口:', err);
                });
              }
            } catch (error) {
              logger.error('处理Tauri关闭事件失败:', error);
            }
          });
        }).catch(err => {
          logger.warn('无法监听Tauri关闭事件:', err);
        });
      } catch (error) {
        logger.warn('Tauri API 不可用:', error);
      }
    }

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // 初始化应用（优化版：防止重复初始化，并行化任务）
  useEffect(() => {
    // 🛡️ 防止 StrictMode 或意外重新挂载导致的重复初始化
    if (initializationStarted.current) {
      logger.debug('[App] 初始化已开始，跳过重复执行');
      return;
    }
    initializationStarted.current = true;

    const initApp = async () => {
      // 🛡️ 双重检查
      if (initializationCompleted.current) {
        logger.debug('[App] 初始化已完成，跳过');
        return;
      }

      try {
        logger.debug('InfloWave 启动中...');

        // 📍 阶段1: 初始化环境（同步，快速）
        window.dispatchEvent(new CustomEvent('app-loading-stage', {
          detail: { stage: 'initializing' }
        }));

        // 初始化环境检测
        initializeEnvironment();

        // 初始化上下文菜单禁用器（生产环境）
        initializeContextMenuDisabler();

        // 📍 阶段2: 并行加载用户偏好和应用配置
        window.dispatchEvent(new CustomEvent('app-loading-stage', {
          detail: { stage: 'loadingPreferences' }
        }));

        // 🚀 优化：用户偏好和应用配置并行加载
        const loadPreferencesPromise = loadUserPreferences()
          .then(() => logger.info('用户偏好设置加载成功'))
          .catch(err => logger.warn('用户偏好设置加载失败，使用默认值:', err));

        const loadConfigPromise = safeTauriInvoke<any>('get_app_config')
          .then(() => logger.debug('应用配置加载成功'))
          .catch(err => logger.warn('应用配置加载失败，使用默认配置:', err));

        // 等待关键配置加载完成（超时 2 秒）
        await Promise.race([
          Promise.all([loadPreferencesPromise, loadConfigPromise]),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);

        // 📍 阶段3: 后台初始化服务（非阻塞）
        window.dispatchEvent(new CustomEvent('app-loading-stage', {
          detail: { stage: 'initializingServices' }
        }));

        // ✅ 连接服务初始化改为后台执行，不阻塞 UI
        safeTauriInvoke<void>('initialize_connections')
          .then(() => {
            logger.debug('连接服务初始化成功');
            const { syncConnectionsFromBackend } = useConnectionStore.getState();
            return syncConnectionsFromBackend();
          })
          .then(() => logger.debug('连接配置后台加载完成'))
          .catch(err => logger.warn('连接服务初始化失败:', err));

        showMessage.success('应用启动成功');
      } catch (error) {
        logger.error('应用初始化失败:', error);
        // 记录到错误日志系统（后台执行）
        errorLogger.logCustomError('应用初始化失败', {
          error: error?.toString(),
          stack: (error as Error)?.stack,
        }).catch(() => {});
        // 不显示错误消息，允许应用继续运行
        logger.warn('应用将以降级模式运行');
      } finally {
        // 标记初始化完成
        initializationCompleted.current = true;

        // 确保窗口标题正确设置
        document.title = 'InfloWave';

        // 如果是Tauri环境，也通过Tauri API设置标题（后台执行）
        if ((window as any).__TAURI__) {
          import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
            getCurrentWebviewWindow().setTitle('InfloWave').catch(err => {
              logger.warn('无法通过Tauri API设置窗口标题:', err);
            });
          }).catch(err => {
            logger.warn('无法导入Tauri webviewWindow模块:', err);
          });
        }

        // 📍 最终阶段: 应用就绪
        window.dispatchEvent(new CustomEvent('app-ready'));
        logger.info('应用启动完成，窗口标题已设置，已发送ready信号');
      }
    };

    // 直接初始化
    initApp();

    return () => {
      // 应用卸载时清理（仅在真正卸载时执行）
      errorLogger.cleanup();
      const { stopConnectionSync } = useConnectionStore.getState();
      stopConnectionSync();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初始化只影响后台服务，不能阻止工作区挂载。
  // 否则 index.html 的启动遮罩已隐藏、但此处仍返回空容器时，用户会看到白屏，
  // 并且工具栏、数据源面板及其“新建连接”等事件监听器都尚未注册。
  // 让工作区立即可用；各服务完成初始化后会自行更新对应状态。

  // 获取通知位置设置，如果没有设置则使用默认值
  const getToasterPosition = () => {
    logger.debug('获取Toaster位置，当前preferences:', preferences);
    if (!preferences?.notifications?.position) {
      logger.debug('使用默认位置: bottom-right');
      return 'bottom-right'; // 默认位置
    }

    // 转换用户偏好中的位置值为 Sonner 支持的格式
    const positionMap: Record<string, string> = {
      'topLeft': 'top-left',
      'topCenter': 'top-center',
      'topRight': 'top-right',
      'bottomLeft': 'bottom-left',
      'bottomCenter': 'bottom-center',
      'bottomRight': 'bottom-right',
    };

    const position = positionMap[preferences.notifications.position] || 'bottom-right';
    logger.debug('计算出的位置:', position, '原始值:', preferences.notifications.position);
    return position;
  };

  return (
    <DialogProvider>
      <ErrorBoundary>
        <MainLayout />
        <DialogManager />
        <ConnectionErrorHandler />
        <Toaster position={getToasterPosition() as any} />

        {/* 未保存标签页对话框 */}
        <UnsavedTabsDialog
          open={showUnsavedTabsDialog}
          unsavedTabs={unsavedTabs}
          onSave={handleDialogSave}
          onDiscard={handleDialogDiscard}
          onCancel={handleDialogCancel}
        />
      </ErrorBoundary>
    </DialogProvider>
  );
};

export default App;
