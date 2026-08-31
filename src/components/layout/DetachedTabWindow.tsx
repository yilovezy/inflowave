import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useTheme } from '@/components/providers/ThemeProvider';
import TableDataBrowser from '@/components/query/TableDataBrowser';
import { QueryToolbar } from '@/components/query/QueryToolbar';
import EnhancedResultPanel from '@/components/layout/EnhancedResultPanel';
import { EditorManager } from '@/components/editor/EditorManager';
import type { EditorManagerRef } from '@/components/editor/EditorManager';
import { useQueryExecutor } from '@/components/editor/QueryExecutor';
import { useConnectionStore } from '@/store/connection';
import { useOpenedDatabasesStore } from '@/stores/openedDatabasesStore';
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
  Button,
} from '@/components/ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { safeTauriInvoke } from '@/utils/tauri';
import { showMessage } from '@/utils/message';
import type { QueryResult } from '@/types';
import { ArrowLeftToLine } from 'lucide-react';
import logger from '@/utils/logger';

interface DetachedTab {
  id: string;
  title: string;
  content: string;
  type: 'query' | 'table' | 'database' | 'data-browser';
  connectionId?: string;
  database?: string;
  tableName?: string;
  modified?: boolean;
  // 查询结果相关字段
  queryResult?: QueryResult | null;
  queryResults?: QueryResult[];
  executedQueries?: string[];
  executionTime?: number;
}

interface DetachedTabWindowProps {
  tab: DetachedTab;
  onReattach?: () => void;
  onClose?: () => void;
}

const DetachedTabWindow: React.FC<DetachedTabWindowProps> = ({
  tab,
  onReattach,
  onClose,
}) => {
  // 🔧 添加详细的初始化日志
  logger.debug('🚀 DetachedTabWindow 组件渲染:', {
    tabId: tab.id,
    tabTitle: tab.title,
    tabType: tab.type,
    hasContent: !!tab.content,
    contentLength: tab.content?.length || 0,
    connectionId: tab.connectionId,
    database: tab.database,
    tableName: tab.tableName,
    modified: tab.modified,
    hasQueryResult: !!tab.queryResult,
    queryResultsCount: tab.queryResults?.length || 0,
  });

  const { resolvedTheme } = useTheme();
  const [content, setContent] = useState(tab.content || '');
  const [modified, setModified] = useState(tab.modified || false);

  // 查询相关状态 - 从localStorage恢复查询结果
  const [selectedDatabase, setSelectedDatabase] = useState(tab.database || '');
  const [selectedTimeRange, setSelectedTimeRange] = useState<any>(undefined); // 默认不限制时间
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryResults, setQueryResults] = useState<QueryResult[]>([]);
  const [executedQueries, setExecutedQueries] = useState<string[]>([]);
  const [executionTime, setExecutionTime] = useState(0);

  // 🔧 从localStorage恢复查询结果
  useEffect(() => {
    logger.debug(`🪟 独立窗口初始化，尝试从localStorage恢复查询结果:`, {
      tabId: tab.id,
      tabTitle: tab.title,
    });

    try {
      const storageKey = `detached-tab-query-${tab.id}`;
      const savedData = localStorage.getItem(storageKey);

      if (savedData) {
        const queryData = JSON.parse(savedData);
        logger.debug('✅ 成功从localStorage恢复查询结果:', {
          hasQueryResult: !!queryData.queryResult,
          queryResultsCount: queryData.queryResults?.length || 0,
          executedQueriesCount: queryData.executedQueries?.length || 0,
        });

        setQueryResult(queryData.queryResult || null);
        setQueryResults(queryData.queryResults || []);
        setExecutedQueries(queryData.executedQueries || []);
        setExecutionTime(queryData.executionTime || 0);

        // 清理localStorage
        localStorage.removeItem(storageKey);
        logger.debug('🧹 已清理localStorage中的查询结果');
      } else {
        logger.debug('ℹ️ localStorage中没有保存的查询结果');
      }
    } catch (error) {
      logger.error('❌ 从localStorage恢复查询结果失败:', error);
    }
  }, [tab.id]);

  const { activeConnectionId, setActiveConnection, connections } = useConnectionStore();
  const { openedDatabasesList } = useOpenedDatabasesStore();
  const editorManagerRef = useRef<EditorManagerRef>(null);

  // 初始化连接ID
  useEffect(() => {
    if (tab.connectionId && tab.connectionId !== activeConnectionId) {
      setActiveConnection(tab.connectionId);
    }
  }, [tab.connectionId, activeConnectionId, setActiveConnection]);

  // 获取数据库列表 - 使用openedDatabasesList而不是connections.databases
  const databases = React.useMemo(() => {
    const connectionId = tab.connectionId || activeConnectionId;
    if (!connectionId) return [];

    const { openedDatabases } = useOpenedDatabasesStore.getState();
    const connectionDatabases: string[] = [];

    for (const key of openedDatabases) {
      if (key.startsWith(`${connectionId}/`)) {
        const database = key.substring(connectionId.length + 1);
        if (database) {
          connectionDatabases.push(database);
        }
      }
    }

    return connectionDatabases;
  }, [tab.connectionId, activeConnectionId, openedDatabasesList]);

  // 🔧 修复问题1：初始化openedDatabasesStore，确保数据库下拉框可用
  useEffect(() => {
    const connectionId = tab.connectionId || activeConnectionId;

    logger.debug('🔍 初始化独立窗口的数据库状态:', {
      connectionId,
      tabDatabase: tab.database,
      currentSelectedDatabase: selectedDatabase,
      availableDatabases: databases,
    });

    // 如果tab有指定的数据库和连接ID，确保这个数据库被添加到openedDatabasesStore中
    if (connectionId && tab.database) {
      const { openedDatabases, openDatabase } = useOpenedDatabasesStore.getState();
      const databaseKey = `${connectionId}/${tab.database}`;

      if (!openedDatabases.has(databaseKey)) {
        logger.info(`➕ 将数据库添加到openedDatabasesStore: ${databaseKey}`);
        openDatabase(connectionId, tab.database);
      } else {
        logger.debug(`✅ 数据库已在openedDatabasesStore中: ${databaseKey}`);
      }
    }
  }, [tab.connectionId, tab.database, activeConnectionId]);

  // 🔧 自动设置数据库下拉框的值
  useEffect(() => {
    logger.debug('🔍 检查数据库自动选择:', {
      tabDatabase: tab.database,
      currentSelectedDatabase: selectedDatabase,
      availableDatabases: databases,
    });

    // 如果tab有指定的数据库，且该数据库在可用列表中，且当前未选择，则自动选择
    if (tab.database && databases.includes(tab.database) && selectedDatabase !== tab.database) {
      logger.debug(`✅ 自动选择数据库: ${tab.database}`);
      setSelectedDatabase(tab.database);
    }
    // 如果tab没有指定数据库，但有可用数据库且当前未选择，则选择第一个
    else if (!tab.database && databases.length > 0 && !selectedDatabase) {
      logger.debug(`✅ 自动选择第一个数据库: ${databases[0]}`);
      setSelectedDatabase(databases[0]);
    }
  }, [tab.database, databases, selectedDatabase]);

  // 创建一个临时的tab对象用于查询执行器
  const currentTab = {
    id: tab.id,
    title: tab.title,
    content: content,
    type: tab.type,
    modified: modified,
    saved: false,
    connectionId: tab.connectionId,
    database: tab.database,
    tableName: tab.tableName,
  };

  // 查询执行器
  const {
    loading,
    actualExecutedQueries,
    hasAnyConnectedInfluxDB,
    executeQuery,
    executeQueryWithContent,
  } = useQueryExecutor({
    currentTab,
    selectedDatabase,
    selectedTimeRange,
    onQueryResult: setQueryResult,
    onBatchQueryResults: (results, queries, time) => {
      setQueryResults(results);
      setExecutedQueries(queries);
      setExecutionTime(time);
      if (results.length === 1) {
        setQueryResult(results[0]);
      }
    },
    onUpdateTab: () => {},
    getSelectedText: () => editorManagerRef.current?.getSelectedText() || null,
  });

  // 处理内容变化
  const handleContentChange = useCallback((value: string) => {
    setContent(value);
    setModified(value !== tab.content);
  }, [tab.content]);

  // 处理移回主窗口
  const handleReattach = useCallback(async () => {
    try {
      // 🔧 获取当前窗口的label
      const currentWindow = getCurrentWindow();
      const windowLabel = currentWindow.label;

      logger.info('🔄 准备移回主窗口:', {
        windowLabel,
        tabId: tab.id,
        tabTitle: tab.title,
      });

      // 🔧 将查询结果保存到localStorage，供主窗口恢复
      if (queryResult || (queryResults && queryResults.length > 0)) {
        const queryData = {
          queryResult: queryResult,
          queryResults: queryResults,
          executedQueries: executedQueries,
          executionTime: executionTime,
        };
        localStorage.setItem(`reattach-tab-query-${tab.id}`, JSON.stringify(queryData));
        logger.info('💾 已保存查询结果到localStorage供主窗口恢复:', {
          tabId: tab.id,
          hasQueryResult: !!queryData.queryResult,
          queryResultsCount: queryData.queryResults?.length || 0,
        });
      }

      // 创建tab数据，不包含查询结果（避免数据过大）
      const tabData = {
        id: tab.id,
        title: tab.title,
        content: content,
        type: tab.type,
        connectionId: tab.connectionId,
        database: selectedDatabase,
        tableName: tab.tableName,
        modified: modified,
        // 🔧 不包含查询结果，避免数据过大
        // queryResult: queryResult,
        // queryResults: queryResults,
        // executedQueries: executedQueries,
        // executionTime: executionTime,
        // 🔧 包含窗口label，用于后端关闭窗口
        windowLabel: windowLabel,
      };

      logger.debug('🔄 移回主窗口，tab数据:', {
        tabId: tabData.id,
        windowLabel: tabData.windowLabel,
      });

      // 🔧 通过Tauri命令通知主窗口，后端会关闭独立窗口
      await safeTauriInvoke('reattach_tab', { tab: tabData });

      logger.debug('✅ 已发送reattach命令，等待后端关闭窗口');

      // 🔧 不再在前端关闭窗口，由后端处理
      // 这样可以确保窗口在主窗口处理完reattach事件后才关闭
    } catch (error) {
      logger.error('❌ 移回主窗口失败:', error);
      showMessage.error('移回主窗口失败');
    }
  }, [tab, content, selectedDatabase, modified, queryResult, queryResults, executedQueries, executionTime]);







  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 不要阻止系统级的复制粘贴快捷键
      const isSystemClipboard = (
        (event.ctrlKey || event.metaKey) &&
        ['c', 'v', 'x', 'a'].includes(event.key.toLowerCase())
      );

      if (isSystemClipboard) {
        return; // 让系统处理复制粘贴
      }

      // Ctrl+S 保存
      if (event.ctrlKey && event.key === 's') {
        event.preventDefault();
        // 保存逻辑
        if (modified) {
          safeTauriInvoke('save_tab_content', { tabId: tab.id, content });
          setModified(false);
          showMessage.success('保存成功');
        }
      }

      // Ctrl+W 关闭窗口
      if (event.ctrlKey && event.key === 'w') {
        event.preventDefault();
        onClose?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [modified, content, tab.id, onClose]);

  // 🔧 调试：打印渲染信息
  logger.debug('🪟 DetachedTabWindow 准备渲染UI:', {
    tabId: tab.id,
    tabTitle: tab.title,
    tabType: tab.type,
    hasConnectionId: !!tab.connectionId,
    hasDatabase: !!tab.database,
    hasTableName: !!tab.tableName,
    hasQueryResult: !!queryResult,
    queryResultsCount: queryResults?.length || 0,
    hasActiveConnection: !!activeConnectionId,
    connectionsCount: connections.length,
  });

  // 🔧 如果是data-browser类型但缺少必要信息，显示错误
  if (tab.type === 'data-browser' && (!tab.connectionId || !tab.database || !tab.tableName)) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold text-destructive mb-4">数据浏览器配置错误</h1>
          <p className="text-muted-foreground mb-2">缺少必要的连接信息</p>
          <pre className="text-xs text-left bg-muted p-4 rounded mt-4">
            {JSON.stringify({
              connectionId: tab.connectionId,
              database: tab.database,
              tableName: tab.tableName,
            }, null, 2)}
          </pre>
        </div>
      </div>
    );
  }

  try {
    return (
      <div className="h-full bg-background flex flex-col">
      {/* 顶部操作栏 */}
      <div className="flex-shrink-0 bg-muted/30 border-b px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{tab.title}</span>
            {modified && <span className="text-xs text-orange-500">●</span>}
            <span className="text-xs text-muted-foreground">({tab.type})</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReattach}
            className="flex items-center gap-2"
          >
            <ArrowLeftToLine className="w-4 h-4" />
            移回主窗口
          </Button>
        </div>
      </div>

      {/* 主要内容区域 */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {tab.type === 'data-browser' ? (
          <TableDataBrowser
            connectionId={tab.connectionId!}
            database={tab.database!}
            tableName={tab.tableName!}
          />
        ) : (
          <ResizablePanelGroup direction="vertical" className="h-full">
            {/* 上半部分: 编辑器 */}
            <ResizablePanel defaultSize={50} minSize={20} className="bg-background">
              <div className="h-full flex flex-col">
                {/* 查询工具栏 */}
                {tab.type === 'query' && (
                  <QueryToolbar
                    selectedConnectionId={tab.connectionId || activeConnectionId}
                    selectedDatabase={selectedDatabase}
                    selectedTimeRange={selectedTimeRange}
                    onConnectionChange={(connectionId) => {
                      setActiveConnection(connectionId);
                      setSelectedDatabase('');
                    }}
                    onDatabaseChange={setSelectedDatabase}
                    onTimeRangeChange={setSelectedTimeRange}
                    onExecuteQuery={executeQuery}
                    onSaveQuery={() => {
                      if (modified) {
                        safeTauriInvoke('save_tab_content', { tabId: tab.id, content });
                        setModified(false);
                        showMessage.success('保存成功');
                      }
                    }}
                    onFormatSQL={() => {
                      // 格式化SQL的逻辑
                      showMessage.info('SQL格式化功能待实现');
                    }}
                    loading={loading}
                    disabled={false}
                  />
                )}

                {/* 编辑器 */}
                <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                  <EditorManager
                    ref={editorManagerRef}
                    currentTab={currentTab}
                    selectedDatabase={selectedDatabase}
                    databases={databases}
                    onContentChange={handleContentChange}
                    onExecuteQuery={executeQuery}
                  />
                </div>
              </div>
            </ResizablePanel>

            {/* 分割线 */}
            {tab.type === 'query' && (
              <>
                <ResizableHandle withHandle className="h-2 bg-border hover:bg-border/80" />

                {/* 下半部分: 结果面板 - 🔧 修复问题2：使用EnhancedResultPanel与主窗口保持一致 */}
                <ResizablePanel defaultSize={50} minSize={20} className="bg-background">
                  <EnhancedResultPanel
                    collapsed={false}
                    queryResult={queryResult}
                    queryResults={queryResults}
                    executedQueries={executedQueries}
                    executionTime={executionTime}
                    onClearResult={() => {
                      setQueryResult(null);
                      setQueryResults([]);
                      setExecutedQueries([]);
                      setExecutionTime(0);
                    }}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        )}
      </div>

      {/* 状态栏 */}
      <div className="flex-shrink-0 bg-muted/50 border-t px-4 py-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-4">
            <span>类型: {tab.type}</span>
            {tab.type === 'data-browser' && tab.tableName && (
              <span>表: {tab.tableName}</span>
            )}
            {modified && <span className="text-orange-500">已修改</span>}
            {selectedDatabase && <span>数据库: {selectedDatabase}</span>}
          </div>
          <div className="flex items-center gap-4">
            <span>Ctrl+S 保存</span>
            <span>Ctrl+W 关闭</span>
          </div>
        </div>
      </div>
    </div>
    );
  } catch (error) {
    logger.error('❌ DetachedTabWindow 渲染错误:', error);
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold text-destructive mb-4">独立窗口渲染错误</h1>
          <p className="text-muted-foreground mb-4">渲染组件时发生错误</p>
          <pre className="text-xs text-left bg-muted p-4 rounded mt-4 max-w-2xl overflow-auto">
            {String(error)}
          </pre>
        </div>
      </div>
    );
  }
};

export default DetachedTabWindow;