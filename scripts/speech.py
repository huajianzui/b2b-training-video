"""显式选择微软兼容端点；不修改全局安装，不静默切换服务。"""
import os


def communicator(text, voice, **options):
    import edge_tts
    service = os.environ.get("EDGE_TTS_SERVICE", "library")
    if service not in ("library", "msedge"):
        raise ValueError("EDGE_TTS_SERVICE 只能是 library 或 msedge")
    if service == "msedge":
        edge_tts.communicate.WSS_URL = (
            "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"
            f"?Ocp-Apim-Subscription-Key={edge_tts.constants.TRUSTED_CLIENT_TOKEN}"
        )
    return edge_tts.Communicate(text, voice, **options)


def reject_forbidden(error):
    if getattr(error, "status", None) in (401, 403):
        raise RuntimeError("微软语音服务拒绝握手（401/403），已停止重复请求。"
                           "请先运行 preflight.js --online 核对当前服务与端点。") from None
