from .profiler import H3StudioFastH3Profile
from .vsa_gb10 import H3StudioFastH3GB10VSA


NODE_CLASS_MAPPINGS = {
    "H3StudioFastH3Profile": H3StudioFastH3Profile,
    "H3StudioFastH3GB10VSA": H3StudioFastH3GB10VSA,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3StudioFastH3Profile": "H3 Studio FastH3 Kernel Profiler",
    "H3StudioFastH3GB10VSA": "H3 Studio VSA Fused Layout Engine",
}
