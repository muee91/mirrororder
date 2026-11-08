from script_organizer.timeline_interop import OTIOInterop


def test_otio_is_an_optional_interop_provider() -> None:
    assert isinstance(OTIOInterop.available(), bool)
