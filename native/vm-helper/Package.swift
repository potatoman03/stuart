// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "StuartVMHelper",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "StuartVMHelper", targets: ["StuartVMHelper"])
    ],
    targets: [
        .executableTarget(
            name: "StuartVMHelper",
            path: "Sources/StuartVMHelper",
            linkerSettings: [
                .linkedFramework("Virtualization")
            ]
        )
    ]
)
