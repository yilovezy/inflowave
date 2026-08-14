import { useCallback } from 'react';
import { useOpenedDatabasesStore } from '@/stores/openedDatabasesStore';
import { showMessage } from '@/utils/message';
import logger from '@/utils/logger';
import type {
    ManagementNodeDialogState,
    ConnectionDetailDialogState
} from '@/types/databaseExplorer';

interface UseNodeActivateHandlerProps {
    onCreateDataBrowserTab?: (connectionId: string, database: string, table: string) => void;
    onCreateS3BrowserTab?: (connectionId: string, connectionName: string, defaultBucket?: string) => void;
    openDatabase: (connectionId: string, database: string) => void;
    setManagementNodeDialog: React.Dispatch<React.SetStateAction<ManagementNodeDialogState>>;
    setConnectionDetailDialog: React.Dispatch<React.SetStateAction<ConnectionDetailDialogState>>;
    setContextMenuOpen: (open: boolean) => void;
    contextMenuOpenRef: React.MutableRefObject<boolean>;
}

/**
 * Custom hook for handling node activation (double-click)
 */
export const useNodeActivateHandler = ({
    onCreateDataBrowserTab,
    onCreateS3BrowserTab,
    openDatabase,
    setManagementNodeDialog,
    setConnectionDetailDialog,
    setContextMenuOpen,
    contextMenuOpenRef,
}: UseNodeActivateHandlerProps) => {
    // ============================================================================
    // Node Activate Handler (Double-click)
    // ============================================================================
    const handleNodeActivate = useCallback(async (node: any) => {
        logger.info('🖱️ [DatabaseExplorer] 双击节点:', {
            name: node.name,
            nodeType: node.nodeType,
            dbType: node.dbType,
            metadata: node.metadata,
        });

        // 关闭右键菜单（使用 ref 避免依赖 contextMenuOpen）
        if (contextMenuOpenRef.current) {
            setContextMenuOpen(false);
        }

        const nodeType = node.nodeType;
        const metadata = node.metadata || {};
        const connectionId = metadata.connectionId || '';
        const database = metadata.database || metadata.databaseName || '';
        const table = metadata.table || metadata.tableName || '';
        const connectionType = metadata.connectionType || metadata.type;

        logger.info(`🔍 [DatabaseExplorer] 节点详情: nodeType=${nodeType}, connectionType=${connectionType}, dbType=${node.dbType}`);

        // 数据库节点：双击打开数据库
        if (nodeType === 'database' || nodeType === 'system_database') {
            logger.info(`📂 [DatabaseExplorer] 双击数据库节点，打开数据库: ${database}`);
            // 使用 getState() 访问最新数据，避免依赖 openedDatabasesSet
            const key = `${connectionId}/${database}`;
            const openedDatabases = useOpenedDatabasesStore.getState().openedDatabases;
            if (!openedDatabases.has(key)) {
                openDatabase(connectionId, database);
                showMessage.success(`已打开数据库 "${database}"`);
            } else {
                logger.info(`📂 [DatabaseExplorer] 数据库已打开，跳过: ${database}`);
            }
            return;
        }

        // InfluxDB 2.x Organization 节点：双击打开 organization
        if (nodeType === 'organization') {
            const organization = node.name;
            logger.info(`📂 [DatabaseExplorer] 双击 Organization 节点，打开 Organization: ${organization}`);
            const { openOrganization, isOrganizationOpened } = useOpenedDatabasesStore.getState();
            if (!isOrganizationOpened(connectionId, organization)) {
                openOrganization(connectionId, organization);
                showMessage.success(`已打开 Organization "${organization}"`);
            } else {
                logger.info(`📂 [DatabaseExplorer] Organization 已打开，跳过: ${organization}`);
            }
            return;
        }

        // InfluxDB 2.x Bucket 节点：双击打开 bucket
        if (nodeType === 'bucket' || nodeType === 'system_bucket') {
            const bucket = node.name;
            const organization = metadata.organization || '';
            logger.info(`📂 [DatabaseExplorer] 双击 Bucket 节点，打开 Bucket: ${bucket}, Organization: ${organization}`);
            const { openBucket, isBucketOpened } = useOpenedDatabasesStore.getState();
            if (!isBucketOpened(connectionId, organization, bucket)) {
                openBucket(connectionId, organization, bucket);
                showMessage.success(`已打开 Bucket "${bucket}"`);
            } else {
                logger.info(`📂 [DatabaseExplorer] Bucket 已打开，跳过: ${bucket}`);
            }
            return;
        }

        // IoTDB 存储组节点：双击打开存储组
        if (nodeType === 'storage_group') {
            const storageGroup = node.name;
            logger.info(`📂 [DatabaseExplorer] 双击存储组节点，打开存储组: ${storageGroup}`);
            const key = `${connectionId}/${storageGroup}`;
            const openedDatabases = useOpenedDatabasesStore.getState().openedDatabases;
            if (!openedDatabases.has(key)) {
                openDatabase(connectionId, storageGroup);
                showMessage.success(`已打开存储组 "${storageGroup}"`);
            } else {
                logger.info(`📂 [DatabaseExplorer] 存储组已打开，跳过: ${storageGroup}`);
            }
            return;
        }

        // 容器节点（connection 等）已经由 MultiConnectionTreeView 的 handleToggle 处理
        // 这里只处理叶子节点

        if (nodeType === 'measurement' || nodeType === 'table') {
            // 表节点：创建数据浏览器标签页
            logger.info(`📊 [DatabaseExplorer] 双击表节点，打开数据浏览器: ${table}`);
            if (onCreateDataBrowserTab) {
                onCreateDataBrowserTab(connectionId, database, table);
                showMessage.success(`正在打开表 "${table}"`);
            }
        } else if (nodeType === 'device') {
            // IoTDB 设备节点：创建数据浏览器标签页
            // 优先从 metadata 中获取设备路径和存储组
            const devicePath = metadata.devicePath || metadata.device_path || table || node.name;
            const storageGroup = metadata.storageGroup || metadata.storage_group || database;

            logger.info(`📊 [DatabaseExplorer] 双击设备节点，打开数据浏览器: ${devicePath}`);
            if (onCreateDataBrowserTab) {
                onCreateDataBrowserTab(connectionId, storageGroup, devicePath);
                showMessage.success(`正在打开设备 "${devicePath}"`);
            }
        } else if (nodeType === 'timeseries' || nodeType === 'aligned_timeseries') {
            // IoTDB 时间序列节点：不应该打开数据浏览器，这是叶子节点
            logger.debug(`📊 [DatabaseExplorer] 时间序列节点 ${node.name} 不支持双击操作`);
            return;
        } else if (nodeType === 'connection') {
            // 检查是否为对象存储连接
            logger.info(`🔌 [DatabaseExplorer] 双击连接节点: ${node.name}, connectionType=${connectionType}, dbType=${node.dbType}`);

            if (connectionType === 'object-storage' && onCreateS3BrowserTab) {
                // 对象存储连接：打开S3浏览器标签
                logger.info(`📦 [DatabaseExplorer] 识别为对象存储节点，准备打开S3浏览器: ${node.name}`);
                const defaultBucket = metadata.defaultBucket || metadata.bucket;

                // 打开对象存储节点
                const { openObjectStorage, isObjectStorageOpened } = useOpenedDatabasesStore.getState();
                if (!isObjectStorageOpened(connectionId)) {
                    openObjectStorage(connectionId);
                    logger.info(`📂 [DatabaseExplorer] 打开对象存储节点: ${connectionId}`);
                } else {
                    logger.info(`📂 [DatabaseExplorer] 对象存储节点已打开: ${connectionId}`);
                }

                logger.info(`📦 [DatabaseExplorer] 调用 onCreateS3BrowserTab: connectionId=${connectionId}, name=${node.name}, bucket=${defaultBucket}`);
                onCreateS3BrowserTab(connectionId, node.name, defaultBucket);
                showMessage.success(`正在打开对象存储面板`);
            } else {
                // 其他连接节点：打开连接详情对话框
                logger.info(`🔌 [DatabaseExplorer] 非对象存储连接，打开详情对话框: ${node.name}`);
                setConnectionDetailDialog({
                    open: true,
                    connectionId,
                });
            }
        } else if (nodeType === 'storage_bucket') {
            const bucket = node.name;
            logger.info(`📦 [DatabaseExplorer] 双击存储桶节点，准备打开S3浏览器: ${bucket}`);
            
            // 确保对象存储节点被标记为已打开
            const { openObjectStorage, isObjectStorageOpened } = useOpenedDatabasesStore.getState();
            if (!isObjectStorageOpened(connectionId)) {
                openObjectStorage(connectionId);
                logger.info(`📂 [DatabaseExplorer] 连带打开对象存储节点: ${connectionId}`);
            }

            // 同样需要标记这个特定的 bucket 为已打开
            const { openDatabase, isDatabaseOpened } = useOpenedDatabasesStore.getState();
            if (!isDatabaseOpened(connectionId, `bucket:${bucket}`)) {
                openDatabase(connectionId, `bucket:${bucket}`);
                logger.info(`📂 [DatabaseExplorer] 标记存储桶为已打开: ${bucket}`);
            }

            if (onCreateS3BrowserTab) {
                // 对于 connectionName 可以通过获取所有连接来查，或者我们直接传 'S3'
                onCreateS3BrowserTab(connectionId, 'S3', bucket);
                showMessage.success(`正在打开存储桶 "${bucket}"`);
            }
        } else if (
            nodeType === 'function' ||
            nodeType === 'trigger' ||
            nodeType === 'system_info' ||
            nodeType === 'version_info' ||
            nodeType === 'schema_template'
        ) {
            // 管理节点：打开详情弹框
            setManagementNodeDialog({
                open: true,
                connectionId,
                nodeType,
                nodeName: node.name,
                nodeCategory: 'management',
            });
        } else {
            logger.debug(`ℹ️ 节点类型 ${nodeType} 的双击行为由 handleToggle 处理`);
        }
    }, [
        onCreateDataBrowserTab,
        onCreateS3BrowserTab,
        openDatabase,
        setManagementNodeDialog,
        setConnectionDetailDialog,
        setContextMenuOpen,
        contextMenuOpenRef,
    ]);

    return {
        handleNodeActivate,
    };
};

