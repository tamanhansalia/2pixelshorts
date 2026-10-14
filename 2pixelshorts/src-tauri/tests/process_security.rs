use pixelshorts_lib::{jobs::run_pipeline_streaming, video_runner::{run_cli_process, run_helper_process}};

fn temporary_dir(label: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("pixel_{}_{}", label, stamp));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn python() -> &'static str { if cfg!(windows) { "python" } else { "python3" } }

#[tokio::test]
async fn progress_is_visible_before_python_exits() {
    let dir = temporary_dir("progress_test");
    let script = dir.join("worker.py");
    std::fs::write(&script, "import time\nprint('[STAGE 1/4] ready')\ntime.sleep(5)\n").unwrap();
    let (ready, received) = tokio::sync::oneshot::channel();
    let mut ready = Some(ready);
    let args = vec![script.to_string_lossy().into_owned()];
    let task = tokio::spawn(async move {
        run_pipeline_streaming(python(), &args, |line| {
            if line.contains("[STAGE 1/4]") { if let Some(ready) = ready.take() { let _ = ready.send(()); } }
        }).await
    });
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), received).await;
    task.abort();
    let _ = task.await;
    assert!(result.is_ok(), "progress was buffered until Python exited");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn helper_keys_are_environment_only_and_logs_are_redacted() {
    let dir = temporary_dir("secret_test");
    let script = dir.join("helper.py");
    std::fs::write(&script, "import sys,os\nassert '--elevenlabs-key' not in sys.argv\nassert 'test-only-secret' not in sys.argv\nassert os.environ['PIXEL_ELEVENLABS_KEY']=='test-only-secret'\nprint(os.environ['PIXEL_ELEVENLABS_KEY'])\nprint(os.environ['PIXEL_ELEVENLABS_KEY'],file=sys.stderr)\n").unwrap();
    let args = vec![script.to_string_lossy().into_owned(), "--elevenlabs-key".into(), "test-only-secret".into()];
    let out = run_helper_process(python(), &args, None).await.unwrap();
    assert!(out.success, "{}", out.stderr);
    assert!(out.stdout.contains("[REDACTED]"));
    assert!(out.stderr.contains("[REDACTED]"));
    assert!(!out.stdout.contains("test-only-secret"));
    let mut lines = Vec::new();
    let out = run_pipeline_streaming(python(), &args, |line| lines.push(line.to_string())).await.unwrap();
    assert!(out.success);
    assert!(lines.iter().all(|line| !line.contains("test-only-secret")));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn user_console_keeps_user_supplied_arguments() {
    let dir = temporary_dir("console_args_test");
    let script = dir.join("console.py");
    std::fs::write(&script, "import sys\nassert sys.argv[1:] == ['--api-key', 'test-only-value']\nprint('arguments-preserved')\n").unwrap();
    let args = vec![script.to_string_lossy().into_owned(), "--api-key".into(), "test-only-value".into()];
    let out = run_cli_process(python(), &args, None).await.unwrap();
    assert!(out.success, "{}", out.stderr);
    assert!(out.stdout.contains("arguments-preserved"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_pipeline_stops_descendant_work() {
    let dir = temporary_dir("cancel_test");
    let marker = dir.join("child_finished");
    let script = dir.join("worker.py");
    std::fs::write(&script, "import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',\"import time,sys;time.sleep(1);open(sys.argv[1],'w').write('orphan')\",sys.argv[1]])\nprint('child-ready',flush=True)\ntime.sleep(10)\n").unwrap();
    let (ready, received) = tokio::sync::oneshot::channel();
    let mut ready = Some(ready);
    let args = vec![script.to_string_lossy().into_owned(), marker.to_string_lossy().into_owned()];
    let task = tokio::spawn(async move {
        run_pipeline_streaming(python(), &args, |line| {
            if line == "child-ready" { if let Some(ready) = ready.take() { let _ = ready.send(()); } }
        }).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), received).await.unwrap().unwrap();
    task.abort();
    let _ = task.await;
    tokio::time::sleep(std::time::Duration::from_millis(1400)).await;
    assert!(!marker.exists(), "cancelled pipeline left a child running");
    std::fs::remove_dir_all(dir).unwrap();
}
