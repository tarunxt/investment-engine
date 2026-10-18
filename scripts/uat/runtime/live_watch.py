"""Monitor/supervisor entrypoint for the existing confined UAT runtime."""
import argparse
from runtime_watcher import watch_runtime


def main(argv=None, *, runtime=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('monitor', 'supervisor'))
    args = parser.parse_args(argv)
    if runtime is None:
        # The existing runtime controller supplies fixed paths, inventory and
        # bounded command adapters. No receipt/environment selects bindings.
        import live_control as runtime
    return watch_runtime(runtime, args.mode)


if __name__ == '__main__':
    main()
