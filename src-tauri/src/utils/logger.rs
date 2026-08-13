use anyhow::Result;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

/// 获取日志目录路径
///
/// 开发环境：使用 src-tauri/logs/（与 cargo 工作目录一致，便于开发时查看）
/// 生产环境：使用应用数据目录的 logs/
///   - macOS: ~/Library/Application Support/com.inflowave.app/logs/
///   - Windows: C:\Users\<user>\AppData\Roaming\com.inflowave.app\logs\
///   - Linux: ~/.local/share/com.inflowave.app/logs/
///
/// 注意：前端日志和后端日志都会写入同一个 logs/ 目录
fn get_log_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    let log_dir = if cfg!(debug_assertions) {
        // 开发环境：使用 cargo 工作目录下的 logs/
        // Tauri 开发模式下，cargo 在 src-tauri 目录运行
        // 所以日志会在 src-tauri/logs/ 目录
        let current_dir = std::env::current_dir()
            .map_err(|e| anyhow::anyhow!("获取当前目录失败: {}", e))?;
        current_dir.join("logs")
    } else {
        // 生产环境：使用应用数据目录
        let app_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| anyhow::anyhow!("获取应用数据目录失败: {}", e))?;
        app_dir.join("logs")
    };

    Ok(log_dir)
}

/// 初始化日志系统
///
/// 功能：
/// 1. 清除旧的日志文件
/// 2. 配置日志输出到文件和控制台
/// 3. 设置日志格式和级别
pub fn init_logger(app_handle: &tauri::AppHandle) -> Result<()> {
    // 获取日志目录（根据环境自动选择）
    let log_dir = get_log_dir(app_handle)?;

    println!("🔍 [Logger] 日志目录: {:?}", log_dir);
    println!("🔍 [Logger] 当前工作目录: {:?}", std::env::current_dir());
    println!("🔍 [Logger] 操作系统: {} {}", std::env::consts::OS, std::env::consts::ARCH);

    // 确保日志目录存在
    match fs::create_dir_all(&log_dir) {
        Ok(_) => println!("✅ [Logger] 日志目录创建成功"),
        Err(e) => {
            eprintln!("❌ [Logger] 创建日志目录失败: {}", e);
            return Err(anyhow::anyhow!("创建日志目录失败: {}", e));
        }
    }

    // 清除旧的后端日志文件
    match clear_old_logs(&log_dir) {
        Ok(_) => println!("✅ [Logger] 清除旧日志成功"),
        Err(e) => {
            eprintln!("⚠️ [Logger] 清除旧日志失败: {}", e);
        }
    }

    // 写入会话开始标记
    match write_session_start(&log_dir) {
        Ok(_) => println!("✅ [Logger] 写入会话标记成功"),
        Err(e) => {
            eprintln!("❌ [Logger] 写入会话标记失败: {}", e);
            return Err(anyhow::anyhow!("写入会话标记失败: {}", e));
        }
    }

    // 配置日志输出
    match setup_logging(&log_dir) {
        Ok(_) => println!("✅ [Logger] 日志系统配置成功"),
        Err(e) => {
            eprintln!("❌ [Logger] 配置日志系统失败: {}", e);
            return Err(anyhow::anyhow!("配置日志系统失败: {}", e));
        }
    }

    let env_type = if cfg!(debug_assertions) { "开发" } else { "生产" };
    tracing::info!("📝 后端日志系统已启动 [{}环境]", env_type);
    tracing::info!("日志目录: {:?}", log_dir);

    println!("✅ [Logger] 日志系统初始化完成");

    Ok(())
}

/// 清除旧的日志文件
fn clear_old_logs(log_dir: &PathBuf) -> Result<()> {
    let backend_log = log_dir.join("backend.log");
    
    if backend_log.exists() {
        fs::remove_file(&backend_log)?;
        println!("已清除旧的后端日志");
    }
    
    Ok(())
}

/// 写入会话开始标记
fn write_session_start(log_dir: &PathBuf) -> Result<()> {
    let backend_log = log_dir.join("backend.log");
    let session_id = format!("session-{}", chrono::Utc::now().timestamp());
    
    let session_info = format!(
        r#"
================================================================================
=== 后端日志会话开始 ===
Session ID: {}
时间: {}
版本: {}
平台: {} {}
================================================================================
"#,
        session_id,
        chrono::Utc::now().to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    
    fs::write(&backend_log, session_info)?;
    
    Ok(())
}

/// 设置日志记录
fn setup_logging(log_dir: &PathBuf) -> Result<()> {
    println!("🔍 [Logger] 开始配置日志系统...");
    println!("🔍 [Logger] 日志文件路径: {:?}", log_dir.join("backend.log"));

    // 创建文件日志 appender - 不使用滚动，每次启动都是新文件
    let file_appender = match RollingFileAppender::builder()
        .rotation(Rotation::NEVER) // 不自动滚动
        .filename_prefix("backend")
        .filename_suffix("log")
        .build(log_dir) {
            Ok(appender) => {
                println!("✅ [Logger] 文件 appender 创建成功");
                appender
            },
            Err(e) => {
                eprintln!("❌ [Logger] 创建文件日志 appender 失败: {}", e);
                return Err(anyhow::anyhow!("创建文件日志 appender 失败: {}", e));
            }
        };

    // 文件日志层 - 记录所有级别
    let file_layer = fmt::layer()
        .with_writer(file_appender)
        .with_ansi(false) // 文件中不使用颜色代码
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(false)
        .with_line_number(true)
        .with_file(true);

    println!("✅ [Logger] 文件日志层配置完成");

    // 控制台日志层 - 只在开发模式下启用
    let console_layer = if cfg!(debug_assertions) {
        println!("✅ [Logger] 启用控制台日志层（开发模式）");
        Some(
            fmt::layer()
                .with_writer(std::io::stdout)
                .with_ansi(true) // 控制台使用颜色
                .with_target(false)
                .with_thread_ids(false)
                .with_thread_names(false)
                .with_line_number(false)
                .with_file(false)
        )
    } else {
        println!("⚠️ [Logger] 控制台日志层已禁用（生产模式）");
        None
    };

    // 环境过滤器 - 根据环境设置默认日志级别
    // 生产环境：只记录 ERROR 和 WARN
    // 开发环境：记录 DEBUG 及以上
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                println!("🔍 [Logger] 开发模式：使用 DEBUG 级别（AWS SDK 和网络底层库使用 INFO 级别）");
                // 开发环境：应用级别使用 debug，网络和 AWS SDK 相关的库使用 info
                EnvFilter::new("debug,aws_smithy_runtime=info,aws_runtime=info,aws_sdk_s3=info,hyper=info,reqwest=info,h2=info,tower=info,rustls=info")
            } else {
                // 生产环境：只记录 ERROR 和 WARN，大幅减少日志输出
                println!("🔍 [Logger] 生产模式：使用 WARN 级别（仅记录警告和错误）");
                EnvFilter::new("warn,aws_smithy_runtime=error,aws_runtime=error,aws_sdk_s3=error,hyper=warn,reqwest=warn")
            }
        });

    // 组合所有层
    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer);

    // 如果有控制台层，添加它
    match if let Some(console) = console_layer {
        subscriber.with(console).try_init()
    } else {
        subscriber.try_init()
    } {
        Ok(_) => {
            println!("✅ [Logger] tracing subscriber 初始化成功");
            Ok(())
        },
        Err(e) => {
            eprintln!("❌ [Logger] tracing subscriber 初始化失败: {}", e);
            Err(anyhow::anyhow!("tracing subscriber 初始化失败: {}", e))
        }
    }
}

/// 获取日志文件路径
pub fn get_log_file_path(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    let log_dir = get_log_dir(app_handle)?;
    Ok(log_dir.join("backend.log"))
}

/// 读取日志文件内容
pub fn read_log_file(app_handle: &tauri::AppHandle) -> Result<String> {
    let log_path = get_log_file_path(app_handle)?;
    
    if !log_path.exists() {
        return Ok(String::new());
    }
    
    let content = fs::read_to_string(log_path)?;
    Ok(content)
}

/// 清空日志文件
pub fn clear_log_file(app_handle: &tauri::AppHandle) -> Result<()> {
    let log_path = get_log_file_path(app_handle)?;
    
    if log_path.exists() {
        fs::remove_file(log_path)?;
    }
    
    Ok(())
}

