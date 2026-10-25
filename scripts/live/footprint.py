import ctypes
import json
import sys


class RUsageInfoV4(ctypes.Structure):
	_fields_ = [
		("ri_uuid", ctypes.c_uint8 * 16),
		("ri_user_time", ctypes.c_uint64),
		("ri_system_time", ctypes.c_uint64),
		("ri_pkg_idle_wkups", ctypes.c_uint64),
		("ri_interrupt_wkups", ctypes.c_uint64),
		("ri_pageins", ctypes.c_uint64),
		("ri_wired_size", ctypes.c_uint64),
		("ri_resident_size", ctypes.c_uint64),
		("ri_phys_footprint", ctypes.c_uint64),
		("ri_proc_start_abstime", ctypes.c_uint64),
		("ri_proc_exit_abstime", ctypes.c_uint64),
		("ri_child_user_time", ctypes.c_uint64),
		("ri_child_system_time", ctypes.c_uint64),
		("ri_child_pkg_idle_wkups", ctypes.c_uint64),
		("ri_child_interrupt_wkups", ctypes.c_uint64),
		("ri_child_pageins", ctypes.c_uint64),
		("ri_child_elapsed_abstime", ctypes.c_uint64),
		("ri_diskio_bytesread", ctypes.c_uint64),
		("ri_diskio_byteswritten", ctypes.c_uint64),
		("ri_cpu_time_qos_default", ctypes.c_uint64),
		("ri_cpu_time_qos_maintenance", ctypes.c_uint64),
		("ri_cpu_time_qos_background", ctypes.c_uint64),
		("ri_cpu_time_qos_utility", ctypes.c_uint64),
		("ri_cpu_time_qos_legacy", ctypes.c_uint64),
		("ri_cpu_time_qos_user_initiated", ctypes.c_uint64),
		("ri_cpu_time_qos_user_interactive", ctypes.c_uint64),
		("ri_billed_system_time", ctypes.c_uint64),
		("ri_serviced_system_time", ctypes.c_uint64),
		("ri_logical_writes", ctypes.c_uint64),
		("ri_lifetime_max_phys_footprint", ctypes.c_uint64),
		("ri_instructions", ctypes.c_uint64),
		("ri_cycles", ctypes.c_uint64),
		("ri_billed_energy", ctypes.c_uint64),
		("ri_serviced_energy", ctypes.c_uint64),
		("ri_interval_max_phys_footprint", ctypes.c_uint64),
		("ri_runnable_time", ctypes.c_uint64),
	]


libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
out = {}
for pid in map(int, sys.argv[1:]):
	info = RUsageInfoV4()
	if libproc.proc_pid_rusage(pid, 4, ctypes.byref(info)) != 0:
		sys.exit(f"proc_pid_rusage failed for {pid}")
	out[pid] = {"footprintMb": info.ri_phys_footprint >> 20, "peakMb": info.ri_lifetime_max_phys_footprint >> 20, "rssMb": info.ri_resident_size >> 20}
print(json.dumps(out))
