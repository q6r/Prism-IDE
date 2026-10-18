use std::io;
use std::mem::{size_of, zeroed};

use tokio::process::{Child, Command};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};

/// An owned Win32 handle, closed on drop.
struct Owned(HANDLE);

// SAFETY: the job handle is only used through thread-safe Win32 calls.
unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: we own the handle and close it exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

pub struct Tree {
    job: Owned,
}

impl Tree {
    pub fn new() -> io::Result<Self> {
        // SAFETY: plain Win32 calls with valid arguments; the handle is owned.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Owned(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { job })
        }
    }

    pub fn spawn(&self, command: &mut Command) -> io::Result<Child> {
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let child = command.spawn()?;
        let joined = match child.raw_handle() {
            // SAFETY: the handle belongs to the live child we just spawned.
            Some(handle) => unsafe { AssignProcessToJobObject(self.job.0, handle as HANDLE) != 0 },
            None => false,
        };
        let pid = child.id();
        if let Some(pid) = pid {
            resume_threads(pid);
        }
        if !joined {
            let err = io::Error::last_os_error();
            drop(child); // kill_on_drop is up to the caller; make sure it does not linger suspended
            return Err(err);
        }
        Ok(child)
    }

    pub fn adopt(&self, pid: u32) -> io::Result<()> {
        // SAFETY: the process handle is opened, used and closed here.
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let process = Owned(process);
            if AssignProcessToJobObject(self.job.0, process.0) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    pub fn kill(&self) -> io::Result<()> {
        // SAFETY: valid job handle.
        if unsafe { TerminateJobObject(self.job.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Resumes every thread of a process started with `CREATE_SUSPENDED`.
fn resume_threads(pid: u32) {
    // SAFETY: snapshot and thread handles are opened and closed here.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return;
        }
        let snapshot = Owned(snapshot);
        let mut entry: THREADENTRY32 = zeroed();
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut more = Thread32First(snapshot.0, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    ResumeThread(thread);
                    CloseHandle(thread);
                }
            }
            more = Thread32Next(snapshot.0, &mut entry) != 0;
        }
    }
}

pub fn child_pids(pid: u32) -> Vec<u32> {
    let mut children = Vec::new();
    // SAFETY: the snapshot handle is opened and closed here.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return children;
        }
        let snapshot = Owned(snapshot);
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot.0, &mut entry) != 0;
        while more {
            if entry.th32ParentProcessID == pid && entry.th32ProcessID != pid && alive(entry.th32ProcessID) {
                children.push(entry.th32ProcessID);
            }
            more = Process32NextW(snapshot.0, &mut entry) != 0;
        }
    }
    children
}

pub fn alive(pid: u32) -> bool {
    // SAFETY: the process handle is opened and closed here.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let process = Owned(process);
        let mut code = 0u32;
        GetExitCodeProcess(process.0, &mut code) != 0 && code == STILL_ACTIVE as u32
    }
}
