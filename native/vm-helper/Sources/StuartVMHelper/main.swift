import Foundation

struct VmStatus: Codable {
    let state: String
    let detail: String
    let imagePath: String?
}

struct PersistedState: Codable {
    var state: String
    var imagePath: String?
}

enum HelperError: Error {
    case invalidArguments
}

@main
struct StuartVMHelper {
    static func main() throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let command = arguments.first else {
            throw HelperError.invalidArguments
        }

        switch command {
        case "status":
            try printJSON(readStatus())
        case "start":
            var state = loadState()
            state.state = "running"
            try saveState(state)
            try printJSON(readStatus())
        case "stop":
            var state = loadState()
            state.state = "stopped"
            try saveState(state)
            try printJSON(readStatus())
        case "verify-image":
            let imagePath = arguments.dropFirst().first
            var state = loadState()
            state.imagePath = imagePath
            try saveState(state)
            try printJSON(readStatus())
        default:
            throw HelperError.invalidArguments
        }
    }

    static func stateDirectory() throws -> URL {
        if let override = ProcessInfo.processInfo.environment["STUART_VM_HELPER_STATE_DIR"]
            ?? ProcessInfo.processInfo.environment["COWORK_VM_HELPER_STATE_DIR"] {
            return URL(fileURLWithPath: override, isDirectory: true)
        }

        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = appSupport.appendingPathComponent("Stuart", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    static func stateFile() throws -> URL {
        try stateDirectory().appendingPathComponent("vm-helper-state.json")
    }

    static func loadState() -> PersistedState {
        do {
            let file = try stateFile()
            guard FileManager.default.fileExists(atPath: file.path) else {
                return PersistedState(state: "stopped", imagePath: nil)
            }
            let data = try Data(contentsOf: file)
            return try JSONDecoder().decode(PersistedState.self, from: data)
        } catch {
            return PersistedState(state: "error", imagePath: nil)
        }
    }

    static func saveState(_ state: PersistedState) throws {
        let file = try stateFile()
        let data = try JSONEncoder().encode(state)
        try data.write(to: file, options: .atomic)
    }

    static func readStatus() -> VmStatus {
        let state = loadState()
        let detail: String
        switch state.state {
        case "running":
            detail = "VM helper is marked as running."
        case "error":
            detail = "State file could not be read."
        default:
            detail = "VM helper is installed but not booting a real guest yet."
        }
        return VmStatus(state: state.state, detail: detail, imagePath: state.imagePath)
    }

    static func printJSON<T: Encodable>(_ value: T) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        guard let string = String(data: data, encoding: .utf8) else {
            throw HelperError.invalidArguments
        }
        print(string)
    }
}
