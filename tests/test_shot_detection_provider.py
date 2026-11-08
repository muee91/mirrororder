from script_organizer.shot_detection_provider import PySceneDetectProvider, provider_status


def test_pyscenedetect_provider_is_optional_and_reports_capability() -> None:
    provider = PySceneDetectProvider()
    status = provider_status(provider)
    assert status["provider"] == "pyscenedetect"
    assert isinstance(status["available"], bool)
