"""
main.py - Ovolve CLI entry point.

Usage:
    python main.py                    # Interactive CLI mode
    python main.py --config path      # Custom config path
    python main.py --command "..."    # Single command mode
    python main.py --server           # Start HTTP server mode (Tauri)
"""
from __future__ import annotations
import sys, os, json, asyncio, argparse

# Windows consoles default to a legacy codepage (GBK on zh-CN), which turns any
# non-ASCII model output into mojibake. Force UTF-8 on the streams we own.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Add backend directory to sys.path for flat imports
BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend")
sys.path.insert(0, BACKEND_DIR)


def load_config(config_path: str = None) -> dict:
    """Load configuration from JSON file."""
    if config_path is None:
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    if not os.path.exists(config_path):
        print(f"Config not found at {config_path}, using defaults.")
        return _default_config()
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        ws = (cfg.get("workspace") or {}).get("root", "")
        if ws:
            abs_ws = os.path.abspath(os.path.join(os.path.dirname(config_path), ws) if not os.path.isabs(ws) else ws)
            os.makedirs(abs_ws, exist_ok=True)
        return cfg
    except Exception as e:
        print(f"Failed to load config: {e}, using defaults.")
        return _default_config()


def _default_config() -> dict:
    return {
        "permissions": {"mode": "auto"},
        "workspace": {"root": os.getcwd()},
        "server": {"host": "127.0.0.1", "port": 8765},
    }


def load_system_prompt() -> str:
    """Load the master system prompt from file."""
    sp_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "system_prompt.md")
    if os.path.exists(sp_path):
        with open(sp_path, "r", encoding="utf-8") as f:
            return f.read()
    return ""


def init_llm(config: dict):
    """Build the LLM client and wire it into every module that needs one.

    Must run BEFORE ``Router`` is constructed: Router resolves the
    memory/goal singletons, and whichever call constructs a singleton first
    fixes its callback. Wiring here is what turns the heuristic fallbacks
    (regex memory extraction, heuristic goal verification, "update N files"
    commit messages) into real model-driven behavior.

    Args:
        config: Parsed config.json.

    Returns:
        The LLMClient instance (already registered as the global singleton).
    """
    from llm_client import get_llm_client
    from memory_layer import get_memory_layer
    from goal_manager import get_goal_manager
    from git_trust import get_commit_message_generator

    llm = get_llm_client(config)

    # Admission control. Opt-in: a provider with no `rate_limit` block stays
    # unlimited, so an untouched config behaves exactly as before. Installed even
    # without an api_key — cheap, and it keeps the wiring in one place.
    try:
        from rate_limiter import get_rate_limiter
        installed = get_rate_limiter().configure(config)
        if installed:
            print(f"[ratelimit] quotas installed for {installed} provider(s)")
    except Exception as e:
        print(f"[warn] rate limiter not configured: {e}")

    if not llm.api_key:
        print("[warn] No LLM api_key configured — running in heuristic-only mode.")
        return llm

    get_memory_layer(llm_callback=llm.call)
    get_goal_manager(llm_callback=llm.call)
    get_commit_message_generator(llm_callback=llm.call)
    print(f"[llm] {llm.model_id} via {llm.base_url}")
    return llm


def init_capabilities(workspace: str) -> dict:
    """Register sub-agents + capability tools and discover on-disk skills.

    Shared by every entrypoint (CLI / single-command / server) so the runtime
    surface is identical: 5 sub-agents, the specialized capability tools
    (red_team_scan / security_audit / diagnose / recommend), and any skills
    sitting under ``.agents/skills`` are all live.

    Args:
        workspace: Active workspace root.

    Returns:
        A summary dict ``{"skills": {...}}`` for logging.
    """
    from file_agent import get_file_agent
    from computer_agent import get_computer_agent
    from app_agent import get_app_agent
    from browser_agent import get_browser_agent
    from search_agent import get_search_agent
    from skill_loader import get_skill_loader
    import red_team, security_audit, diagnostics, recommender

    get_file_agent(workspace)
    get_computer_agent(workspace)
    get_app_agent(workspace)
    get_browser_agent(workspace)
    get_search_agent(workspace)

    # Specialized capability tools (red_team_scan / security_audit / diagnose / recommend).
    for mod in (red_team, security_audit, diagnostics, recommender):
        try:
            mod.register_tools()
        except Exception as e:  # never let one tool block startup
            print(f"[warn] register_tools failed for {mod.__name__}: {e}")

    # Every tool the built-in agents own is registered by now, so this is the
    # first honest moment to check the sub-agent allowlists against reality.
    # An allowlist is enforced by hiding what's outside it, so a misspelled
    # entry blinds a persona without any error — worth one line at startup.
    try:
        from subagent_registry import warn_on_unknown_allowed_tools
        warn_on_unknown_allowed_tools()
    except Exception:
        pass

    # Auto-discover skills on disk (skill_loader.discover was never called before,
    # so .agents/skills content was invisible at runtime).
    skills = {"loaded": [], "failed": []}
    try:
        skills = get_skill_loader().discover()
        if skills.get("loaded"):
            print(f"[skills] loaded {len(skills['loaded'])}: {', '.join(skills['loaded'])}")
        for f in skills.get("failed", []):
            print(f"[skills] skipped {f.get('name')}: {f.get('error')}")
    except Exception as e:
        print(f"[warn] skill discovery failed: {e}")
    return {"skills": skills}


async def run_cli(config: dict):
    """Run interactive CLI mode."""
    from router import Router
    from risk_control import init_risk_controller

    workspace = config.get("workspace", {}).get("root", os.getcwd())
    perm_mode = config.get("permissions", {}).get("mode", "auto")

    # Initialize risk controller with config mode
    init_risk_controller(perm_mode)

    # Wire the LLM before Router constructs the memory/goal singletons.
    init_llm(config)

    # Initialize router with system prompt
    system_prompt = load_system_prompt()
    router = Router(workspace=workspace, system_prompt=system_prompt)

    # Initialize sub-agents, capability tools, and on-disk skills.
    init_capabilities(workspace)

    # Print banner
    print("=" * 60)
    print("  Ovolve - Desktop AI Agent")
    print("  Type 'exit' or 'quit' to stop.")
    print("  Type 'help' for available commands.")
    print("=" * 60)
    print()

    # Interactive loop
    while True:
        try:
            user_input = input("You> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not user_input:
            continue
        if user_input.lower() in ("exit", "quit"):
            print("Goodbye!")
            break
        if user_input.lower() == "help":
            _print_help()
            continue
        if user_input.lower() == "status":
            _print_status(router)
            continue
        if user_input.lower() == "tools":
            _print_tools(router)
            continue

        # Process through router
        try:
            result = await router.handle(user_input)
            if result.ok:
                print(f"\nOvolve> {result.value}\n")
            else:
                print(f"\nOvolve> Error: {result.error}\n")
        except Exception as e:
            print(f"\nOvolve> Internal error: {e}\n")


def _print_help():
    """Print help information."""
    print("""
Available commands:
  help    - Show this help
  status  - Show system status
  tools   - List available tools
  exit    - Quit Ovolve

You can also type natural language requests like:
  - "list current directory files"
  - "read README.md"
  - "search for TODO in code"
  - "git status"
""")


def _print_status(router):
    """Print system status."""
    print(f"""
System Status:
  Session ID: {router.session_id}
  Workspace:  {router.workspace}
  Risk Mode:  {router.risk.mode.value}
  Tools:      {len(router.tools._tools)} registered
  Messages:   {len(router.storage.get_messages(router.session_id))}
""")


def _print_tools(router):
    """List available tools."""
    tools = router.tools.list_tools()
    print(f"\nRegistered Tools ({len(tools)}):")
    for t in sorted(tools, key=lambda x: x.name):
        print(f"  [{t.risk_level:6s}] {t.name:20s} - {t.description}")


async def run_single_command(config: dict, command: str):
    """Run a single command and exit."""
    from router import Router
    from risk_control import init_risk_controller

    workspace = config.get("workspace", {}).get("root", os.getcwd())
    perm_mode = config.get("permissions", {}).get("mode", "auto")
    init_risk_controller(perm_mode)

    # Wire the LLM before Router (same pattern as run_cli).
    init_llm(config)

    router = Router(workspace=workspace, system_prompt=load_system_prompt())

    init_capabilities(workspace)

    result = await router.handle(command)
    if result.ok:
        print(result.value)
    else:
        print(f"Error: {result.error}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Ovolve Desktop AI Agent")
    parser.add_argument("--config", type=str, default=None, help="Path to config.json")
    parser.add_argument("--command", type=str, default=None, help="Single command to execute")
    parser.add_argument("--server", action="store_true", help="Start HTTP server mode")
    args = parser.parse_args()

    config = load_config(args.config)

    if args.command:
        asyncio.run(run_single_command(config, args.command))
    elif args.server:
        from server.http_server import run_server
        cfg_path = args.config or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "config.json"
        )
        run_server(config, system_prompt=load_system_prompt(), config_path=cfg_path)
    else:
        asyncio.run(run_cli(config))


if __name__ == "__main__":
    main()
